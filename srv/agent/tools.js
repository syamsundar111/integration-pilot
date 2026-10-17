/**
 * Agent tools (OpenAI function-calling format) and their handlers.
 *
 * The LLM can only READ from CPI and PROPOSE changes. Proposals are stored as PENDING
 * and executed only after a user approves them (srv/lib/proposals.js).
 */
const cds = require('@sap/cds')
const cpi = require('../lib/cpi-client')
const { validate, schema } = require('../iflow-builder/validator')
const { build, injectAttachments } = require('../iflow-builder/builder')
const attachmentStore = require('../lib/attachments')
const { parse } = require('../iflow-builder/parser')
const { specFromParsed, describeChanges } = require('../iflow-builder/to-spec')

const LOG = cds.log('agent')
const MAX_RESULT_CHARS = 12_000
const MAX_ERRORS = 15 // validation errors returned to the model per call
const PACKAGE_ID = /^[A-Za-z0-9.]+$/ // CPI rejects underscores and other special characters

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
})

const definitions = [
  fn('listPackages', 'List integration packages on the tenant (id, name, short text).'),
  fn('listIflows', 'List the iFlows of one package.', { packageId: { type: 'string' } }, ['packageId']),
  fn('getIflowDetails', 'Design-time details, externalized parameters and runtime status of one iFlow.', { iflowId: { type: 'string' } }, ['iflowId']),
  fn(
    'getRuntimeStatus',
    'Runtime status of deployed artifacts. With iflowId: status of that iFlow, including the error text if it failed. Without: all deployed artifacts.',
    { iflowId: { type: 'string' } }
  ),
  fn(
    'getMessageLogs',
    'Recent message processing logs, newest first.',
    {
      status: { type: 'string', enum: cpi.MESSAGE_STATUSES },
      sinceHours: { type: 'integer', minimum: 1, maximum: 720 },
      top: { type: 'integer', minimum: 1, maximum: 50 }
    }
  ),
  fn('getSupportedSteps', 'The iFlow spec v1 JSON schema with examples: what can be built and how to write a spec. Call before proposing an iFlow.'),
  fn(
    'validateSpec',
    'Validate a complete iFlow spec with the same checks the builder runs. Always call it before proposeIflow/proposeIflowUpdate and fix every error first. Returns { valid: true } or compact errors "CODE path: message".',
    { spec: { type: 'object', description: 'Complete iFlow spec v1' } },
    ['spec']
  ),
  fn('explainIflow', 'Parse an existing iFlow (trigger, steps, adapters, parameters, scripts) to explain it.', { iflowId: { type: 'string' } }, ['iflowId']),
  fn(
    'proposeIflow',
    'Propose a new iFlow for the user to approve. After validateSpec returned valid, call it with { "useValidatedSpec": true } instead of sending the spec again. Nothing is created until the user approves.',
    {
      useValidatedSpec: { type: 'boolean', description: 'true: propose the spec the last validateSpec call accepted' },
      spec: { type: 'object', description: 'Complete iFlow spec v1 (only if you did not validate it)' }
    }
  ),
  fn(
    'getIflowSpec',
    'The current content of an existing iFlow as an iFlow spec v1, to change it with proposeIflowUpdate. Returns blockers instead if the iFlow contains things the spec cannot express (an update would lose them).',
    { iflowId: { type: 'string' } },
    ['iflowId']
  ),
  fn(
    'proposeIflowUpdate',
    'Propose new content for an EXISTING iFlow (same id and package). Start from getIflowSpec, change only what the user asked for, validate the complete spec with validateSpec, then call this with { "useValidatedSpec": true }. Nothing changes until the user approves.',
    {
      useValidatedSpec: { type: 'boolean', description: 'true: propose the spec the last validateSpec call accepted' },
      spec: { type: 'object', description: 'Complete iFlow spec v1 of the updated iFlow (only if you did not validate it)' }
    }
  ),
  fn(
    'proposePackage',
    'Propose a new integration package for the user to approve (only if no suitable package exists).',
    { id: { type: 'string', description: 'Letters, digits and dots only (no underscores)' }, name: { type: 'string' }, shortText: { type: 'string' } },
    ['id', 'name']
  )
]

// --- helpers -----------------------------------------------------------------------

/** Validation result for the model: codes and short messages, never the spec itself */
function compactInvalid(issues, instruction) {
  const errors = issues.slice(0, MAX_ERRORS).map((i) => `${i.code} ${i.message}`)
  if (issues.length > MAX_ERRORS) errors.push(`… ${issues.length - MAX_ERRORS} more; fix these first`)
  return { valid: false, errors, ...(instruction && { instruction }) }
}

/** The spec to propose: the one passed, or the one the last validateSpec call of this turn accepted */
function specToPropose({ spec, useValidatedSpec }, ctx) {
  if (spec) return { spec }
  if (useValidatedSpec && ctx.validatedSpec) return { spec: ctx.validatedSpec }
  return {
    error: compactInvalid([{ code: 'NO_VALIDATED_SPEC', message: 'spec: no validated spec — call validateSpec with the complete spec first, then propose with { "useValidatedSpec": true }' }])
  }
}

const notFound = (e) => e.status === 404

async function packageExists(id) {
  try {
    await cpi.getPackage(id)
    return true
  } catch (e) {
    if (notFound(e)) return false
    throw e
  }
}

async function iflowExists(id) {
  try {
    return await cpi.getIflow(id)
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

/** Existing packages that look like the requested id (typos, case, partial names) */
async function similarPackages(requested) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const want = norm(requested)
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) d[0][j] = j
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    return d[a.length][b.length]
  }
  const packages = await cpi.listPackages().catch(() => [])
  return packages
    .map((p) => {
      const id = norm(p.id)
      const name = norm(p.name)
      const score = id === want || name === want ? 0 : id.includes(want) || want.includes(id) || name.includes(want) ? 1 : Math.min(distance(id, want), distance(name, want))
      return { id: p.id, name: p.name, score }
    })
    .filter((p) => p.score <= Math.max(2, Math.floor(want.length / 4)))
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map(({ id, name }) => ({ id, name }))
}

/** Attached files of the conversation, { fileName: content } (cached for the turn) */
async function attachmentsOf(ctx) {
  ctx.attachments ??= ctx.sessionId ? await attachmentStore.contents(ctx.user, ctx.sessionId) : {}
  return ctx.attachments
}

/** Stores a PENDING proposal in its own transaction, so it survives a failing chat turn */
async function storeProposal(ctx, { kind, spec, iflowId = null, packageId = null, operation = 'CREATE', attachments = {} }) {
  const ID = cds.utils.uuid()
  // the attached files the spec uses, as they are now: approval and retry build from this snapshot
  const used = Object.fromEntries(attachmentStore.referencedBy(spec).map((f) => [f, attachments[f]]))
  await cds.tx({ user: ctx.user }, (tx) =>
    tx.run(
      INSERT.into('iflowpilot.Proposal').entries({
        ID,
        session_ID: ctx.sessionId,
        kind,
        operation,
        spec: JSON.stringify(spec),
        status: 'PENDING',
        iflowId,
        packageId,
        attachments: Object.keys(used).length ? JSON.stringify(used) : null
      })
    )
  )
  ctx.proposals.push(ID)
  return ID
}

/** The existing iFlow as a spec, or null if it does not exist: { spec, blockers, packageId } */
async function currentSpec(iflowId) {
  const iflow = await iflowExists(iflowId)
  if (!iflow) return null
  const [zip, configurations] = await Promise.all([cpi.downloadIflowZip(iflowId), cpi.getConfigurations(iflowId).catch(() => [])])
  const result = specFromParsed(await parse(zip), { packageId: iflow.packageId, configurations })
  if (result.spec) Object.assign(result.spec, { id: iflowId, name: iflow.name || result.spec.name }) // CPI's id and display name win over the bundle headers
  return { ...result, packageId: iflow.packageId }
}

/**
 * Moves the scripts and XSLT files of an existing iFlow's spec into the conversation's
 * attachments and returns the spec without code, so the model never receives script bodies.
 * An upload of the user with the same name is kept: it replaces the iFlow's file.
 */
async function detachFiles(ctx, spec, resources = {}) {
  const steps = [...spec.steps, ...(spec.exceptionSubprocess?.steps || [])].filter((s) => s.type === 'groovyScript' && s.code != null)
  const files = [...steps.map((s) => ({ fileName: `${s.fileName}.groovy`, content: s.code })), ...Object.entries(resources).map(([fileName, content]) => ({ fileName, content }))]
  const stored = new Set(files.length ? await attachmentStore.save(ctx.user, ctx.sessionId, files, 'iflow') : [])
  ctx.attachments = undefined // reload: new files
  const strip = (s) => (s.type === 'groovyScript' && s.code != null ? (({ code, ...rest }) => rest)(s) : s)
  return {
    spec: { ...spec, steps: spec.steps.map(strip), ...(spec.exceptionSubprocess && { exceptionSubprocess: { ...spec.exceptionSubprocess, steps: spec.exceptionSubprocess.steps.map(strip) } }) },
    attachedFiles: files.map((f) => f.fileName).filter((f) => stored.has(f)),
    keptUploads: files.map((f) => f.fileName).filter((f) => !stored.has(f))
  }
}

// --- handlers ----------------------------------------------------------------------

const handlers = {
  async listPackages() {
    return (await cpi.listPackages()).map(({ id, name, shortText }) => ({ id, name, shortText }))
  },

  async listIflows({ packageId }) {
    return (await cpi.listIflows(packageId)).map(({ id, name, version, modifiedAt }) => ({ id, name, version, modifiedAt }))
  },

  async getIflowDetails({ iflowId }) {
    const [iflow, configurations, runtime] = await Promise.all([
      cpi.getIflow(iflowId),
      cpi.getConfigurations(iflowId).catch(() => []),
      cpi.getRuntimeArtifact(iflowId)
    ])
    return { ...iflow, configurations, runtime: runtime ? { status: runtime.status, deployedOn: runtime.deployedOn, version: runtime.version } : 'not deployed' }
  },

  async getRuntimeStatus({ iflowId } = {}) {
    if (iflowId) {
      const runtime = await cpi.getRuntimeArtifact(iflowId, { noCache: true })
      if (!runtime) return { iflowId, status: 'NOT_DEPLOYED' }
      const error = runtime.status === 'ERROR' ? await cpi.getRuntimeError(iflowId) : null
      return { ...runtime, error: error?.message || null }
    }
    const all = await cpi.listRuntimeArtifacts()
    const counts = all.reduce((acc, a) => ({ ...acc, [a.status]: (acc[a.status] || 0) + 1 }), {})
    return { counts, artifacts: all.slice(0, 50).map(({ id, name, type, status, deployedOn }) => ({ id, name, type, status, deployedOn })) }
  },

  async getMessageLogs({ status, sinceHours = 24, top = 20 } = {}) {
    return cpi.listMessageLogs({ status, sinceHours, top })
  },

  async getSupportedSteps() {
    return {
      schema: { ...schema, examples: undefined },
      examples: schema.examples,
      notes: [
        'Flows are linear: trigger -> steps in order -> end. Error handling goes into the optional top-level exceptionSubprocess (not into steps).',
        'exceptionSubprocess runs when a step fails; its result is returned to the HTTPS sender. ${exception.message} holds the error text; set header CamelHttpResponseCode to return an HTTP error status.',
        'To change an existing iFlow: getIflowSpec, change the spec, proposeIflowUpdate. Never use proposeIflow with an existing id.',
        'HTTP receivers always use authType "None". If authentication is needed, say the user must set it in the CPI web editor after creation.',
        'Externalized parameters ({{Name}}) are only supported as HTTP receiver URLs; define each in "parameters".',
        'Groovy: import com.sap.gateway.ip.core.customdev.util.Message and define def Message processData(Message message).'
      ]
    }
  },

  async validateSpec({ spec }, ctx) {
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix every error and call validateSpec again.')
    try {
      await build(spec, { attachments }) // the builder's own checks: the spec must turn into an iFlow zip
    } catch (e) {
      return compactInvalid(e.errors ? e.errors.map((m) => ({ code: 'BUILD', message: m })) : [{ code: 'BUILD', message: `spec: cannot be built — ${e.message}` }])
    }
    ctx.validatedSpec = spec
    return { valid: true, next: 'Propose it with { "useValidatedSpec": true }; do not send the spec again.' }
  },

  async explainIflow({ iflowId }) {
    const parsed = await parse(await cpi.downloadIflowZip(iflowId))
    const { files, ...summary } = parsed
    summary.scripts = summary.scripts.map((s) => ({ ...s, content: s.content.length > 4000 ? s.content.slice(0, 4000) + '\n// … truncated' : s.content }))
    return summary
  },

  async proposeIflow(args, ctx) {
    const { spec, error } = specToPropose(args, ctx)
    if (error) return error
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix these errors, call validateSpec, then propose again.')

    // Fail early on things the user could not approve successfully
    const existing = await iflowExists(spec.id)
    if (existing)
      return {
        valid: false,
        errors: [
          `id: an iFlow '${spec.id}' already exists in package '${existing.packageId}' — to change it, call getIflowSpec and then proposeIflowUpdate; for a new iFlow choose a different id`
        ]
      }
    const pkgExists = await packageExists(spec.packageId)

    const { summary } = await build(spec, { attachments }) // proves the spec builds into a zip
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', spec, iflowId: spec.id, packageId: spec.packageId, attachments })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      summary: { trigger: summary.trigger, steps: summary.steps.map((s) => `${s.name} (${s.type})`), end: summary.end, exceptionSubprocess: summary.exceptionSubprocess, parameters: summary.parameters },
      ...(!pkgExists && {
        packageNote: `Package '${spec.packageId}' does not exist on the tenant. Tell the user. They choose in the proposal panel: use an existing package or create '${spec.packageId}' with a name. Mention the similar packages, if any.`,
        similarPackages: await similarPackages(spec.packageId)
      }),
      instruction: 'Tell the user the proposal is ready for review in the proposal panel. Nothing has been created yet.'
    }
  },

  async getIflowSpec({ iflowId }, ctx) {
    const current = await currentSpec(iflowId)
    if (!current) return { error: { code: 'IFLOW_NOT_FOUND', message: `iFlow '${iflowId}' does not exist. Use listIflows to find the id.` } }
    if (current.blockers.length)
      return {
        editable: false,
        blockers: current.blockers,
        instruction:
          'This iFlow cannot be updated here: an update rebuilds it from the spec and would lose the blockers. Tell the user, list the blockers, and suggest changing it in the CPI web editor or creating a new iFlow.'
      }
    const { spec, attachedFiles, keptUploads } = await detachFiles(ctx, current.spec, current.resources)
    return {
      editable: true,
      spec,
      ...(attachedFiles.length && { attachedFiles }),
      ...(keptUploads.length && { keptUploads }),
      instruction:
        'Change only what the user asked for, keep everything else as it is, validate the complete spec with validateSpec and call proposeIflowUpdate. Scripts and XSLT files are attached files: keep their steps without code' +
        (keptUploads.length ? `; the user's uploads ${keptUploads.join(', ')} replace the iFlow's current files.` : '.')
    }
  },

  async proposeIflowUpdate(args, ctx) {
    const { spec, error } = specToPropose(args, ctx)
    if (error) return error
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix these errors, call validateSpec, then propose again.')
    const current = await currentSpec(spec.id)
    if (!current) return { valid: false, errors: [`id: iFlow '${spec.id}' does not exist — use proposeIflow to create a new iFlow`] }
    if (current.packageId !== spec.packageId)
      return { valid: false, errors: [`packageId: iFlow '${spec.id}' is in package '${current.packageId}' — an update keeps the package, set packageId to '${current.packageId}'`] }
    if (current.blockers.length) return { valid: false, errors: current.blockers.map((b) => `not updatable: ${b}`), instruction: 'Tell the user this iFlow cannot be updated here, and why.' }

    // compare with the scripts filled in: the current spec has code, the proposed one references attachments
    const changes = describeChanges({ ...current.spec, resources: undefined }, { ...injectAttachments(spec, attachments), resources: undefined })
    if (JSON.stringify(current.spec.resources || []) !== JSON.stringify(spec.resources || [])) changes.push('XSLT files changed')
    for (const f of spec.resources || []) if (current.resources?.[f] != null && current.resources[f] !== attachments[f]) changes.push(`${f} replaced`)
    if (!changes.length) return { valid: false, errors: ['NO_CHANGE spec: nothing changed compared to the current iFlow'] }
    const { summary } = await build(spec, { attachments })
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', operation: 'UPDATE', spec, iflowId: spec.id, packageId: spec.packageId, attachments })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      operation: 'UPDATE',
      changes,
      summary: { trigger: summary.trigger, steps: summary.steps.map((s) => `${s.name} (${s.type})`), end: summary.end, exceptionSubprocess: summary.exceptionSubprocess, parameters: summary.parameters },
      instruction:
        'Tell the user the update is ready for review in the proposal panel and list the changes. Mention: approving replaces the iFlow content (save a version in the CPI web editor first if they want to keep the old one), and a deployed iFlow runs the old version until they approve with deploy. Nothing has changed yet.'
    }
  },

  async proposePackage({ id, name, shortText }, ctx) {
    const errors = []
    if (!PACKAGE_ID.test(id || '')) errors.push('id: use letters, digits and dots only (CPI does not allow underscores)')
    if (!name) errors.push('name: required')
    if (errors.length) return { valid: false, errors }
    if (await packageExists(id)) return { valid: false, errors: [`id: package '${id}' already exists — use it instead of proposing a new one`] }
    const proposalId = await storeProposal(ctx, { kind: 'PACKAGE', spec: { id, name, shortText: shortText || name }, packageId: id })
    return { valid: true, proposalId, status: 'PENDING', instruction: 'Tell the user the package proposal is ready for review. Nothing has been created yet.' }
  }
}

const SPEC_TOOLS = new Set(['validateSpec', 'proposeIflow', 'proposeIflowUpdate'])
const SPEC_OBJECT_FIELDS = ['trigger', 'steps', 'end', 'exceptionSubprocess', 'parameters']

const parseJsonString = (v) => {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/**
 * Models sometimes send the spec without the { spec } wrapper, as a JSON string, or with its
 * nested objects (trigger, steps, …) as JSON strings. Accept those shapes instead of failing.
 */
function normalizeSpecArgs(args) {
  const { useValidatedSpec, ...rest } = args
  let spec = rest.spec === undefined && (rest.id || rest.steps || rest.trigger) ? rest : parseJsonString(rest.spec)
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    spec = { ...spec }
    for (const f of SPEC_OBJECT_FIELDS) if (f in spec) spec[f] = parseJsonString(spec[f])
  }
  return { spec, useValidatedSpec: useValidatedSpec === true || useValidatedSpec === 'true' }
}

/**
 * Executes one tool call; never throws (errors are returned to the LLM so it can react).
 * @param {{ sessionId: string, proposals: string[] }} ctx
 * @returns {Promise<string>} JSON result (truncated)
 */
async function execute(name, rawArgs, ctx) {
  let result
  const handler = handlers[name]
  if (!handler) result = { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool '${name}'. Available: ${Object.keys(handlers).join(', ')}` } }
  else {
    let args
    try {
      args = rawArgs ? (typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs) : {}
    } catch {
      result = { error: { code: 'INVALID_ARGUMENTS', message: 'Tool arguments are not valid JSON. Send a JSON object.' } }
    }
    if (args) {
      if (SPEC_TOOLS.has(name)) args = normalizeSpecArgs(args)
      try {
        result = await handler(args, ctx)
      } catch (e) {
        LOG.warn(`tool ${name} failed:`, e.code, e.message)
        result = { error: { code: e.code || 'TOOL_ERROR', message: e.message, hint: e.hint } }
      }
    }
  }
  let json = JSON.stringify(result ?? null)
  if (json.length > MAX_RESULT_CHARS) json = json.slice(0, MAX_RESULT_CHARS) + '… [truncated]'
  return json
}

module.exports = { definitions, execute }
