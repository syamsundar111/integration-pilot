/**
 * Agent tools (OpenAI function-calling format) and their handlers.
 *
 * The LLM can only READ from CPI and PROPOSE changes. Proposals are stored as PENDING
 * and executed only after a user approves them (srv/lib/proposals.js).
 */
const cds = require('@sap/cds')
const cpi = require('../lib/cpi-client')
const { validate, schema, GROOVY_IMPORT, GROOVY_ENTRY } = require('../iflow-builder/validator')
const { build, injectAttachments } = require('../iflow-builder/builder')
const attachmentStore = require('../lib/attachments')
const groovyCheck = require('../lib/groovy-check')
const { parse } = require('../iflow-builder/parser')
const { specFromParsed, describeChanges } = require('../iflow-builder/to-spec')

const LOG = cds.log('agent')
const MAX_RESULT_CHARS = 12_000
const MAX_ERRORS = 15 // validation errors returned to the model per call
const MAX_STEPS_PER_EDIT = 8 // steps added or replaced per editDraftSpec call: keeps each answer short
const DRAFT_FIELDS = ['id', 'name', 'description', 'packageId', 'trigger', 'end', 'parameters', 'resources', 'exceptionSubprocess']
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
  fn(
    'getSupportedSteps',
    'The iFlow spec v1 format in short: what can be built and how to write a spec, with one example. Call once before proposing an iFlow. { "full": true } returns the complete JSON schema (rarely needed).',
    { full: { type: 'boolean' } }
  ),
  fn(
    'validateSpec',
    'Check a spec with the same checks as proposing, without proposing it. proposeIflow validates too, so use this only after a failed proposal. Returns { valid: true } or compact errors "CODE path: message".',
    {
      spec: { type: 'object', description: 'Complete iFlow spec v1' },
      useDraftSpec: { type: 'boolean', description: "true: validate the conversation's draft spec (see Context) instead of sending one" }
    }
  ),
  fn(
    'writeScript',
    'Write or replace one Groovy script of this conversation as plain code (never put Groovy code into a spec). Its syntax is checked right away. A groovyScript step then uses it with { "fileName": "<name>" } and no "code".',
    {
      fileName: { type: 'string', description: 'Without extension, e.g. mapUsers (letters, digits, underscore; starts with a letter)' },
      code: { type: 'string', description: 'The complete Groovy script' }
    },
    ['fileName', 'code']
  ),
  fn(
    'editDraftSpec',
    `Build or change the conversation's draft spec in small parts instead of sending the whole spec. ops run in order, all or none:
{"op":"set","fields":{id,name,description,packageId,trigger,end,parameters,resources,exceptionSubprocess}} sets top-level fields (starts a new draft if there is none; exceptionSubprocess: {"name"} or null),
{"op":"addSteps","steps":[...],"at":<index, default: the end>,"exception":<true: exception subprocess>},
{"op":"replaceStep","index":<0-based>,"step":{...},"exception":<bool>},
{"op":"removeStep","index":<0-based>,"exception":<bool>}.
At most ${MAX_STEPS_PER_EDIT} steps added or replaced per call. Returns the draft outline and its open validation errors.`,
    { ops: { type: 'array', items: { type: 'object' }, description: 'Edit operations, applied in order' } },
    ['ops']
  ),
  fn('getDraftSpec', "The conversation's draft spec (e.g. an imported iFlow), to change it. Scripts are attached files: keep their steps without code."),
  fn('explainIflow', 'Parse an existing iFlow (trigger, steps, adapters, parameters, scripts) to explain it.', { iflowId: { type: 'string' } }, ['iflowId']),
  fn(
    'proposeIflow',
    'Propose a new iFlow for the user to approve. Validates the spec and returns errors to fix, so send the complete spec here directly (no validateSpec before). A draft built with editDraftSpec: { "useDraftSpec": true }. Nothing is created until the user approves.',
    {
      useDraftSpec: { type: 'boolean', description: "true: propose the conversation's draft spec (built with editDraftSpec)" },
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
    'Propose new content for an EXISTING iFlow (same id and package). Start from getIflowSpec (its spec becomes the draft), change only what the user asked for with editDraftSpec, then call this with { "useDraftSpec": true }. Validates and returns errors to fix. Nothing changes until the user approves.',
    {
      useDraftSpec: { type: 'boolean', description: "true: propose the conversation's draft spec (built with editDraftSpec)" },
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

/** The spec format in short (getSupportedSteps); test/agent.test.js keeps it in line with spec-schema.json */
const SPEC_FORMAT = {
  spec: '{ id, name, description?, packageId, trigger, steps: [step] (max 50), end, exceptionSubprocess?, parameters?, resources? }',
  trigger: ['{ "type": "httpsSender", "address": "/path/segments" }', '{ "type": "timer", "mode": "once" }'],
  steps: {
    contentModifier: '{ type, name?, description?, headers?: [entry], properties?: [entry], body?: string }; entry = { name, type: "constant"|"expression", value, datatype? }',
    groovyScript: '{ type, name?, description?, fileName } — code written with writeScript (or attached), never in the spec',
    jsonToXml: '{ type, name?, description? }',
    xmlToJson: '{ type, name?, description? }',
    requestReplyHttp: '{ type, name?, description?, system?, url: "https://…" | "{{Param}}", method: GET|POST|PUT|PATCH|DELETE, authType: "None" }'
  },
  end: ['{ "type": "none" }', '{ "type": "httpReceiver", system?, url, method, authType: "None" }'],
  exceptionSubprocess: '{ name?, steps: 1-10 of contentModifier | groovyScript | jsonToXml | xmlToJson }',
  parameters: '{ "Name": "default value" } — used only as a whole receiver url "{{Name}}"',
  resources: '[ "file.xsl" ] — attached XSLT files, added as mapping/<file>',
  names: 'id: letters, digits, _ · packageId: letters, digits, dots · fileName, system: letter first, then letters, digits, _ · step names unique'
}

/** Validation result for the model: codes and short messages, never the spec itself */
function compactInvalid(issues, instruction) {
  const errors = issues.slice(0, MAX_ERRORS).map((i) => `${i.code} ${i.message}`)
  if (issues.length > MAX_ERRORS) errors.push(`… ${issues.length - MAX_ERRORS} more; fix these first`)
  return { valid: false, errors, ...(instruction && { instruction }) }
}

/**
 * Groovy syntax check of every script the spec builds (written in the spec or attached):
 * { issues } on syntax errors, { warning } when the checker is unavailable and not required
 */
async function groovySyntax(spec, attachments) {
  const own = new Set([...spec.steps, ...(spec.exceptionSubprocess?.steps || [])].filter((s) => s.type === 'groovyScript' && s.code != null).map((s) => s.fileName))
  const filled = injectAttachments(spec, attachments)
  const scripts = [...filled.steps, ...(filled.exceptionSubprocess?.steps || [])]
    .filter((s) => s.type === 'groovyScript' && typeof s.code === 'string')
    .map((s) => ({ fileName: `${s.fileName}.groovy`, code: s.code, attached: !own.has(s.fileName) }))
  const { checked, errors, reason } = await groovyCheck.checkScripts(scripts.map(({ fileName, code }) => ({ fileName, code })))
  if (!checked)
    return groovyCheck.required()
      ? { issues: [{ code: 'GROOVY_NOT_CHECKED', message: `scripts: the Groovy syntax check is unavailable (${reason}); try again later` }] }
      : { issues: [], warning: `Groovy syntax not checked: ${reason}` }
  const attached = new Set(scripts.filter((s) => s.attached).map((s) => s.fileName))
  return {
    issues: errors.map((e) => ({
      code: 'GROOVY_SYNTAX',
      message: `${e.fileName}:${e.line}:${e.column}: ${e.message}${attached.has(e.fileName) ? ' (attached file: tell the user to fix it and attach it again)' : ''}`
    }))
  }
}

/** A spec sent as a JSON string that does not parse: say where, instead of "must be a JSON object" */
function unparsableSpec(spec) {
  if (typeof spec !== 'string') return null
  try {
    JSON.parse(spec)
    return null
  } catch (e) {
    return compactInvalid([
      {
        code: 'SPEC_NOT_JSON',
        message: `spec: sent as a string that is not valid JSON (${e.message}) — send spec as a JSON object, not a string. Long Groovy code breaks easily: keep scripts short, or ask the user to attach them.`
      }
    ])
  }
}

/**
 * The spec to propose: the one passed, the conversation's draft spec (useDraftSpec), or the one
 * the last validateSpec call accepted (in this turn, or kept as the draft from an earlier one)
 */
async function specToPropose({ spec, useValidatedSpec, useDraftSpec }, ctx) {
  if (spec) return { spec }
  if (useDraftSpec) {
    const draft = await draftOf(ctx)
    if (draft?.spec) return { spec: draft.spec }
    return { error: compactInvalid([{ code: 'NO_DRAFT', message: 'spec: this conversation has no draft spec — build it with editDraftSpec or send the complete spec' }]) }
  }
  if (useValidatedSpec && ctx.validatedSpec) return { spec: ctx.validatedSpec }
  const draft = useValidatedSpec ? await draftOf(ctx) : null
  if (draft?.valid) return { spec: draft.spec }
  return {
    error: compactInvalid([{ code: 'NO_VALIDATED_SPEC', message: 'spec: no validated spec — send the complete spec, or { "useDraftSpec": true } for a draft built with editDraftSpec' }])
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

/** The conversation's draft spec { spec, source, at }, or null */
async function draftOf(ctx) {
  if (!ctx.sessionId) return null
  const s = await cds.tx({ user: ctx.user }, (tx) => tx.run(SELECT.one.from('iflowpilot.ChatSession', ctx.sessionId).columns('draftSpec')))
  return s?.draftSpec ? JSON.parse(s.draftSpec) : null
}

/**
 * Keeps the latest spec of the conversation as session state (draftSpec), so the history does
 * not need to carry copies of it. Specs never contain attached script bodies.
 */
async function saveDraft(ctx, spec, { source, valid = false }) {
  if (!ctx.sessionId || !spec || typeof spec !== 'object') return
  const draft = { spec, source, valid, at: new Date().toISOString() }
  await cds.tx({ user: ctx.user }, (tx) => tx.run(UPDATE('iflowpilot.ChatSession', ctx.sessionId).set({ draftSpec: JSON.stringify(draft) })))
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

  async getSupportedSteps({ full } = {}) {
    // The compact format is enough to write a spec and is about a quarter of the schema's size; it is
    // re-sent with every later model call of the message, so its size counts several times.
    return {
      ...(full ? { schema: { ...schema, examples: undefined } } : { format: SPEC_FORMAT }),
      example: schema.examples[0],
      notes: [
        'Flows are linear: trigger -> steps in order -> end. Error handling goes into the optional top-level exceptionSubprocess (not into steps).',
        'exceptionSubprocess runs when a step fails; its result is returned to the HTTPS sender. ${exception.message} holds the error text; set header CamelHttpResponseCode to return an HTTP error status.',
        'To change an existing iFlow: getIflowSpec, change the spec, proposeIflowUpdate. Never use proposeIflow with an existing id.',
        'HTTP receivers always use authType "None". If authentication is needed, say the user must set it in the CPI web editor after creation.',
        'Externalized parameters ({{Name}}) are only supported as HTTP receiver URLs; define each in "parameters".',
        'Groovy: import com.sap.gateway.ip.core.customdev.util.Message and define def Message processData(Message message).',
        'Write every Groovy script with writeScript (plain code), then reference it in the spec by fileName without code; never put Groovy code into a spec.',
        'Send the complete spec in one proposeIflow call (it validates). Only when an answer was cut off for length: build the draft with editDraftSpec (set, then addSteps with at most 8 steps per call) and propose { useDraftSpec: true }; fix single steps with replaceStep.',
        'Proposing checks the syntax of every Groovy script (GROOVY_SYNTAX file:line:column: message); fix your scripts with writeScript, ask the user to fix attached ones.'
      ]
    }
  },

  async validateSpec({ spec, useDraftSpec }, ctx) {
    const draft = !spec && useDraftSpec ? await draftOf(ctx) : null
    if (draft) spec = draft.spec
    if (!spec) return compactInvalid([{ code: 'NO_SPEC', message: useDraftSpec ? 'spec: this conversation has no draft spec' : 'spec: missing — send the complete spec' }])
    const notJson = unparsableSpec(spec)
    if (notJson) return notJson
    const source = draft ? draft.source : 'your latest validateSpec'
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) {
      await saveDraft(ctx, spec, { source })
      return compactInvalid(issues, 'Fix every error and call validateSpec again.')
    }
    try {
      await build(spec, { attachments }) // the builder's own checks: the spec must turn into an iFlow zip
    } catch (e) {
      await saveDraft(ctx, spec, { source })
      return compactInvalid(e.errors ? e.errors.map((m) => ({ code: 'BUILD', message: m })) : [{ code: 'BUILD', message: `spec: cannot be built — ${e.message}` }])
    }
    const groovy = await groovySyntax(spec, attachments)
    if (groovy.issues.length) {
      await saveDraft(ctx, spec, { source })
      return compactInvalid(groovy.issues, 'Fix the scripts and call validateSpec again.')
    }
    ctx.validatedSpec = spec
    await saveDraft(ctx, spec, { source, valid: true })
    return { valid: true, ...(groovy.warning && { warnings: [groovy.warning] }), next: 'Propose it with { "useValidatedSpec": true }; do not send the spec again.' }
  },

  async writeScript({ fileName, code }, ctx) {
    fileName = String(fileName || '').replace(/\.groovy$/, '')
    const errors = []
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fileName)) errors.push({ code: 'BAD_FORMAT', message: 'fileName: use a letter, then letters, digits or underscore (no extension)' })
    if (typeof code !== 'string' || !code.trim()) errors.push({ code: 'MISSING_FIELD', message: 'code: the complete Groovy script is missing' })
    else {
      if (!GROOVY_IMPORT.test(code)) errors.push({ code: 'GROOVY_IMPORT', message: `${fileName}.groovy: must import com.sap.gateway.ip.core.customdev.util.Message` })
      if (!GROOVY_ENTRY.test(code)) errors.push({ code: 'GROOVY_ENTRY', message: `${fileName}.groovy: must define 'def Message processData(Message message)' and return the message` })
    }
    if (errors.length) return compactInvalid(errors, 'Fix the script and call writeScript again.')
    const file = `${fileName}.groovy`
    const existing = await attachmentStore.list(ctx.user, ctx.sessionId)
    if (existing.some((f) => f.fileName === file && f.origin === 'upload'))
      return compactInvalid([{ code: 'ATTACHED_BY_USER', message: `${file}: the user attached this file — use it as it is, or write your script under another fileName` }])
    const { checked, errors: syntax, reason } = await groovyCheck.checkScripts([{ fileName: file, code }])
    if (syntax.length) return compactInvalid(syntax.map((e) => ({ code: 'GROOVY_SYNTAX', message: `${e.fileName}:${e.line}:${e.column}: ${e.message}` })), 'Fix the script and call writeScript again.')
    if (!checked && groovyCheck.required()) return compactInvalid([{ code: 'GROOVY_NOT_CHECKED', message: `${file}: the Groovy syntax check is unavailable (${reason}); try again later` }])
    await attachmentStore.save(ctx.user, ctx.sessionId, [{ fileName: file, content: code }], 'ai')
    ctx.attachments = undefined // reload: new content
    ;(ctx.written ??= []).push(file)
    return {
      stored: file,
      lines: code.split('\n').length,
      ...(!checked && { warnings: [`Groovy syntax not checked: ${reason}`] }),
      next: `Use it with { "type": "groovyScript", "fileName": "${fileName}" } and no "code".`
    }
  },

  async editDraftSpec({ ops }, ctx) {
    ops = parseJsonString(ops)
    if (!Array.isArray(ops) || !ops.length) return compactInvalid([{ code: 'NO_OPS', message: 'ops: send a list of edit operations' }])
    const current = await draftOf(ctx)
    let draft = current?.spec ? JSON.parse(JSON.stringify(current.spec)) : null
    const issues = []
    let stepsWritten = 0
    ops.forEach((raw, n) => {
      const op = parseJsonString(raw) || {}
      const at = `ops[${n}]`
      const list = () => {
        if (!draft) return issues.push({ code: 'NO_DRAFT', message: `${at}: there is no draft yet — start with {"op":"set","fields":{id, name, packageId, trigger, end}}` }), null
        if (!op.exception) return (draft.steps ??= [])
        draft.exceptionSubprocess ??= { steps: [] }
        return (draft.exceptionSubprocess.steps ??= [])
      }
      const index = (steps) => {
        if (!Number.isInteger(op.index) || op.index < 0 || op.index >= steps.length) {
          issues.push({ code: 'BAD_INDEX', message: `${at}: index ${op.index} is not a step (0..${steps.length - 1})` })
          return false
        }
        return true
      }
      switch (op.op) {
        case 'set': {
          const fields = parseJsonString(op.fields) || {}
          const unknown = Object.keys(fields).filter((k) => !DRAFT_FIELDS.includes(k))
          if (unknown.length) return issues.push({ code: 'UNKNOWN_FIELD', message: `${at}: fields ${unknown.join(', ')} cannot be set here (steps: use addSteps)` })
          draft ??= { steps: [] }
          for (const [k, v] of Object.entries(fields)) {
            const value = parseJsonString(v)
            if (value === null) delete draft[k]
            else if (k === 'exceptionSubprocess') draft.exceptionSubprocess = { ...(value.name && { name: value.name }), steps: draft.exceptionSubprocess?.steps || [] }
            else draft[k] = value
          }
          return
        }
        case 'addSteps': {
          const steps = (parseJsonString(op.steps) || []).map(parseJsonString)
          const target = list()
          if (!target) return
          if (!steps.length) return issues.push({ code: 'NO_STEPS', message: `${at}: steps is empty` })
          stepsWritten += steps.length
          const pos = Number.isInteger(op.at) ? Math.min(Math.max(op.at, 0), target.length) : target.length
          target.splice(pos, 0, ...steps)
          return
        }
        case 'replaceStep': {
          const target = list()
          if (!target || !index(target)) return
          stepsWritten++
          target[op.index] = parseJsonString(op.step)
          return
        }
        case 'removeStep': {
          const target = list()
          if (!target || !index(target)) return
          target.splice(op.index, 1)
          return
        }
        default:
          issues.push({ code: 'UNKNOWN_OP', message: `${at}: op '${op.op}' is not set, addSteps, replaceStep or removeStep` })
      }
    })
    if (stepsWritten > MAX_STEPS_PER_EDIT)
      issues.push({ code: 'TOO_MANY', message: `ops: ${stepsWritten} steps in one call — send at most ${MAX_STEPS_PER_EDIT} per call` })
    if (issues.length) return compactInvalid(issues, 'Nothing was changed. Fix the operations and call editDraftSpec again.')

    await saveDraft(ctx, draft, { source: 'built with editDraftSpec' })
    ctx.validatedSpec = undefined // the draft changed: validate it again before proposing
    const attachments = await attachmentsOf(ctx)
    const open = validate(draft, { attachments: Object.keys(attachments) }).issues
    const outline = (steps = []) => steps.map((s, i) => `${i}. ${s?.name || '(no name)'} (${s?.type || '?'})`)
    return {
      saved: true,
      id: draft.id,
      steps: outline(draft.steps),
      ...(draft.exceptionSubprocess && { exceptionSteps: outline(draft.exceptionSubprocess.steps) }),
      ...(open.length && { openIssues: compactInvalid(open).errors }),
      next: open.length
        ? 'Continue with editDraftSpec; when the draft is complete, propose it with { "useDraftSpec": true }.'
        : 'The draft is complete: propose it with { "useDraftSpec": true }.'
    }
  },

  async getDraftSpec(_args, ctx) {
    const draft = await draftOf(ctx)
    if (!draft) return { error: { code: 'NO_DRAFT', message: 'This conversation has no draft spec.' } }
    return { source: draft.source, spec: draft.spec, instruction: 'To change it, use editDraftSpec, then propose with { "useDraftSpec": true }.' }
  },

  async explainIflow({ iflowId }) {
    const parsed = await parse(await cpi.downloadIflowZip(iflowId))
    const { files, ...summary } = parsed
    summary.scripts = summary.scripts.map((s) => ({ ...s, content: s.content.length > 4000 ? s.content.slice(0, 4000) + '\n// … truncated' : s.content }))
    return summary
  },

  async proposeIflow(args, ctx) {
    const { spec, error } = await specToPropose(args, ctx)
    if (error) return error
    const notJson = unparsableSpec(spec)
    if (notJson) return notJson
    if (args.spec) await saveDraft(ctx, spec, { source: 'your latest proposeIflow' })
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix only what these errors name and propose again.')

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
    const groovy = await groovySyntax(spec, attachments)
    if (groovy.issues.length) return compactInvalid(groovy.issues, 'Fix the scripts with writeScript and propose again.')
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', spec, iflowId: spec.id, packageId: spec.packageId, attachments })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      ...(groovy.warning && { warnings: [groovy.warning] }),
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
    await saveDraft(ctx, spec, { source: `current content of iFlow ${iflowId}` })
    return {
      editable: true,
      spec,
      ...(attachedFiles.length && { attachedFiles }),
      ...(keptUploads.length && { keptUploads }),
      instruction:
        'Change only what the user asked for, keep everything else as it is, edit the draft with editDraftSpec and call proposeIflowUpdate with { "useDraftSpec": true }. Scripts and XSLT files are attached files: keep their steps without code' +
        (keptUploads.length ? `; the user's uploads ${keptUploads.join(', ')} replace the iFlow's current files.` : '.')
    }
  },

  async proposeIflowUpdate(args, ctx) {
    const { spec, error } = await specToPropose(args, ctx)
    if (error) return error
    const notJson = unparsableSpec(spec)
    if (notJson) return notJson
    if (args.spec) await saveDraft(ctx, spec, { source: 'your latest proposeIflowUpdate' })
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix only what these errors name and propose again.')
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
    const groovy = await groovySyntax(spec, attachments)
    if (groovy.issues.length) return compactInvalid(groovy.issues, 'Fix the scripts with writeScript and propose again.')
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', operation: 'UPDATE', spec, iflowId: spec.id, packageId: spec.packageId, attachments })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      ...(groovy.warning && { warnings: [groovy.warning] }),
      operation: 'UPDATE',
      changes,
      summary: { trigger: summary.trigger, steps: summary.steps.map((s) => `${s.name} (${s.type})`), end: summary.end, exceptionSubprocess: summary.exceptionSubprocess, parameters: summary.parameters },
      instruction:
        'Tell the user the update is ready for review in the proposal panel and list the changes. Mention: approving replaces the iFlow content after backing it up (stored with the proposal and saved as a CPI version; "Restore previous version" on the iFlows page puts it back), and a deployed iFlow runs the old version until they approve with deploy. Nothing has changed yet.'
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
  const { useValidatedSpec, useDraftSpec, ...rest } = args
  let spec = rest.spec === undefined && (rest.id || rest.steps || rest.trigger) ? rest : parseJsonString(rest.spec)
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    spec = { ...spec }
    for (const f of SPEC_OBJECT_FIELDS) if (f in spec) spec[f] = parseJsonString(spec[f])
  }
  return { spec, useValidatedSpec: useValidatedSpec === true || useValidatedSpec === 'true', useDraftSpec: useDraftSpec === true || useDraftSpec === 'true' }
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
