/**
 * Agent tools (OpenAI function-calling format) and their handlers.
 *
 * The LLM can only READ from CPI and PROPOSE changes. Proposals are stored as PENDING
 * and executed only after a user approves them (srv/lib/proposals.js).
 */
const fs = require('fs')
const path = require('path')
const cds = require('@sap/cds')
const cpi = require('../lib/cpi-client')
const { validate, normalizeTypes, hasScriptSecret, schema, GROOVY_IMPORT, GROOVY_ENTRY } = require('../iflow-builder/validator')
const { build } = require('../iflow-builder/builder')
const attachmentStore = require('../lib/attachments')
const groovyCheck = require('../lib/groovy-check')
const { sampleResponse } = require('../lib/sample-response')
const { parse } = require('../iflow-builder/parser')
const { specFromParsed, describeChanges } = require('../iflow-builder/to-spec')

const LOG = cds.log('agent')
const MAX_RESULT_CHARS = 12_000
const MAX_ERRORS = 15 // validation errors returned to the model per call
const MAX_STEPS_PER_EDIT = 8 // steps added or replaced per editDraftSpec call: keeps each answer short
// Worked patterns (srv/agent/patterns/*.md), read on demand so the system prompt stays short
const PATTERNS = Object.fromEntries(['processDirect', 'updateIflow', 'importedIflow', 'odata'].map((n) => [n, path.join(__dirname, 'patterns', `${n}.md`)]))
const patternCache = {}

// Groovy code in a chat message: a CPI entry function or a CPI import
const GROOVY_IN_TEXT = /\bdef\s+Message\s+processData\s*\(|\bimport\s+com\.sap\.(gateway|it)\./
const DRAFT_FIELDS = ['id', 'name', 'description', 'packageId', 'trigger', 'end', 'parameters', 'resources', 'exceptionSubprocess']
const { toPackageId } = require('../lib/package-id')

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
})

const definitions = [
  fn('listPackages', 'Integration packages (id, name, short text).'),
  fn('listIflows', 'iFlows of one package.', { packageId: { type: 'string' } }, ['packageId']),
  fn('getIflowDetails', 'Details, parameters and runtime status of one iFlow.', { iflowId: { type: 'string' } }, ['iflowId']),
  fn('getRuntimeStatus', 'Runtime status of deployed artifacts; with iflowId one iFlow, incl. its error.', { iflowId: { type: 'string' } }),
  fn('getMessageLogs', 'Recent message processing logs, newest first; iflowId for one iFlow.', {
    iflowId: { type: 'string' },
    status: { type: 'string', enum: cpi.MESSAGE_STATUSES },
    sinceHours: { type: 'integer', minimum: 1, maximum: 720 },
    top: { type: 'integer', minimum: 1, maximum: 50 }
  }),
  fn('getSupportedSteps', 'Spec v1 format in short, with an example. Call once before proposing. full: the JSON schema (rarely needed).', { full: { type: 'boolean' } }),
  fn('validateSpec', 'Check a spec without proposing it; only after a failed proposal. Returns { valid } or errors "CODE path: message".', {
    spec: { type: 'object' },
    useDraftSpec: { type: 'boolean', description: 'validate the draft spec' }
  }),
  fn(
    'writeScript',
    'Write or replace one Groovy script (plain code, checked at once). Steps use it by fileName, without code.',
    { fileName: { type: 'string', description: 'No extension, e.g. mapUsers' }, code: { type: 'string' } },
    ['fileName', 'code']
  ),
  fn(
    'editDraftSpec',
    `Build or change the draft spec in parts; ops run in order, all or none:
{"op":"set","fields":{id,name,description,packageId,trigger,end,parameters,resources,exceptionSubprocess}}
{"op":"addSteps","steps":[...],"at":<index>,"exception":<bool>}
{"op":"replaceStep","index":<0-based>,"step":{...},"exception":<bool>}
{"op":"removeStep","index":<0-based>,"exception":<bool>}
At most ${MAX_STEPS_PER_EDIT} steps per call. Returns the outline and open errors.`,
    { ops: { type: 'array', items: { type: 'object' } } },
    ['ops']
  ),
  fn(
    'getSampleResponse',
    'Structure of one response of a public GET URL without auth (the real URL, not {{param}}); use it before writing a script that reads it.',
    { url: { type: 'string' } },
    ['url']
  ),
  fn(
    'getPattern',
    'Worked pattern: processDirect (iFlow calls iFlow), updateIflow (change an existing iFlow), importedIflow (imported draft), odata (script reads OData).',
    { name: { type: 'string', enum: Object.keys(PATTERNS) } },
    ['name']
  ),
  fn('getDraftSpec', "The conversation's draft spec, to change it."),
  fn('explainIflow', 'Parse an existing iFlow to explain it.', { iflowId: { type: 'string' } }, ['iflowId']),
  fn('proposeIflow', 'Propose a NEW iFlow (validates; returns errors to fix). Send the complete spec, no validateSpec before.', {
    spec: { type: 'object' },
    useDraftSpec: { type: 'boolean', description: 'propose the draft (editDraftSpec)' },
    useValidatedSpec: { type: 'boolean', description: 'propose the spec validateSpec accepted' }
  }),
  fn('getIflowSpec', 'Current content of an existing iFlow as a spec (it becomes the draft), or blockers.', { iflowId: { type: 'string' } }, ['iflowId']),
  fn('proposeIflowUpdate', 'Propose new content for an EXISTING iFlow: getIflowSpec, editDraftSpec, then { useDraftSpec: true }. Validates.', {
    spec: { type: 'object' },
    useDraftSpec: { type: 'boolean', description: 'propose the draft (editDraftSpec)' },
    useValidatedSpec: { type: 'boolean', description: 'propose the spec validateSpec accepted' }
  }),
  fn(
    'proposePackage',
    'Propose a new package (only if none fits).',
    { id: { type: 'string', description: 'Letters, digits, dots; a name like test_1 becomes test1' }, name: { type: 'string' }, shortText: { type: 'string' } },
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
  names: 'id: letters, digits, _ · packageId: letters, digits, dots (a Name with _ or spaces is turned into the ID) · fileName, system: letter first, then letters, digits, _ · step names unique'
}

/** Validation result for the model: codes and short messages, never the spec itself */
function compactInvalid(issues, instruction) {
  const errors = issues.slice(0, MAX_ERRORS).map((i) => `${i.code} ${i.message}`)
  if (issues.length > MAX_ERRORS) errors.push(`… ${issues.length - MAX_ERRORS} more; fix these first`)
  return { valid: false, errors, ...(instruction && { instruction }) }
}

/**
 * Groovy syntax check of every script the spec builds (written in the spec or attached):
 * { issues } on syntax errors, { warning } when the checker is unavailable and not required, and
 * the status per file (stored with the proposal, shown in the proposal panel)
 */
async function groovySyntax(spec, attachments) {
  const own = new Set([...spec.steps, ...(spec.exceptionSubprocess?.steps || [])].filter((s) => s.type === 'groovyScript' && s.code != null).map((s) => `${s.fileName}.groovy`))
  const { checked, failed, reason, files } = await groovyCheck.checkSpecScripts(spec, attachments)
  if (!checked)
    return groovyCheck.required()
      ? { files, issues: [{ code: 'GROOVY_NOT_CHECKED', message: `scripts: the Groovy syntax check is unavailable (${reason}); try again later` }] }
      : { files, issues: [], warning: `Groovy syntax not checked: ${reason}` }
  return {
    files,
    issues: failed.map((e) => ({
      code: 'GROOVY_SYNTAX',
      message: `${e.fileName}:${e.line}:${e.column}: ${e.message}${own.has(e.fileName) ? '' : ' (attached file: tell the user to fix it and attach it again)'}`
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

async function getPackageOrNull(id) {
  try {
    return await cpi.getPackage(id)
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

/**
 * A package value with underscores or spaces is the package Name; its ID drops what CPI does not
 * allow (Name "test_1" -> ID "test1"), as CPI does. Asks the user only when nothing is left or the
 * ID belongs to a package with another name.
 * @returns {Promise<{ id: string, name: string|null, note: string|null, error?: string }>}
 */
async function resolvePackage(value, field = 'packageId') {
  const r = toPackageId(value)
  if (!r.name) return r
  if (!r.id) return { ...r, error: `${field}: '${r.name}' has no letters or digits for a package ID — ask the user for a package ID (letters, digits and dots)` }
  const existing = await getPackageOrNull(r.id)
  if (existing && existing.name && existing.name !== r.name)
    return { ...r, error: `${field}: '${r.name}' becomes the package ID '${r.id}', but package '${r.id}' already exists with the name '${existing.name}' — ask the user whether to use that package or to give another name` }
  return { ...r, name: existing ? null : r.name } // an existing package keeps its name
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

/**
 * The package rule, enforced: on the first message of a conversation, a new iFlow needs a package the
 * user named (in a message, by ID or name) or a session default. Otherwise the model must ask instead of
 * choosing one itself. From the second message on the user has had the chance to answer (also "use
 * sensible defaults"), so the model's choice stands. AGENT_ASK_PACKAGE=false turns it off (tests).
 */
async function packageNotGiven(ctx, spec, pkg) {
  if (process.env.AGENT_ASK_PACKAGE === 'false' || !ctx.sessionId) return null
  if ((await defaultsOf(ctx)).packageId) return null
  const rows = await cds.tx({ user: ctx.user }, (tx) =>
    tx.run(SELECT.from('iflowpilot.ChatMessage').columns('role', 'content', 'toolCalls').where({ session_ID: ctx.sessionId, role: { in: ['user', 'assistant'] } }))
  )
  if (rows.some((m) => m.role === 'assistant' && !m.toolCalls)) return null // not the first message
  const text = [ctx.message || '', ...rows.filter((m) => m.role === 'user').map((m) => m.content || '')].join('\n').toLowerCase()
  const packages = await cpi.listPackages().catch(() => [])
  const existing = packages.find((p) => p.id === spec.packageId) || (await getPackageOrNull(spec.packageId).catch(() => null))
  const named = [spec.packageId, pkg?.name, existing?.name].filter(Boolean).some((n) => text.includes(String(n).toLowerCase()))
  if (named) return null
  const suggestions = packages.slice(0, 5).map((p) => `${p.id} (${p.name})`)
  return {
    valid: false,
    errors: [`PACKAGE_NOT_GIVEN packageId: the user did not name a target package and there is no session default`],
    instruction: `Nothing was proposed. Ask the user which package to use${suggestions.length ? `, e.g. ${suggestions.join(', ')}` : ''}, or whether to create a new one; do not choose one yourself. Keep the scripts you wrote; propose the same spec with the package the user names.`
  }
}

/** Tool-result field for type fixes the assistant must mention */
const autoFixes = (fixes) =>
  fixes.length ? { autoFixes: [`type expression -> constant (the value has no \${...}): ${fixes.join(', ')}`], autoFixNote: 'Tell the user these fixes in one line.' } : {}

/** The conversation's session defaults ({ packageId?, packageName?, ... }) */
async function defaultsOf(ctx) {
  if (!ctx.sessionId) return {}
  const s = await cds.tx({ user: ctx.user }, (tx) => tx.run(SELECT.one.from('iflowpilot.ChatSession', ctx.sessionId).columns('defaults')))
  return s?.defaults ? JSON.parse(s.defaults) : {}
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
async function storeProposal(ctx, { kind, spec, iflowId = null, packageId = null, packageName = null, operation = 'CREATE', attachments = {}, scriptChecks = null, changes = null }) {
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
        packageName,
        attachments: Object.keys(used).length ? JSON.stringify(used) : null,
        scriptChecks: scriptChecks && Object.keys(scriptChecks).length ? JSON.stringify(scriptChecks) : null,
        changes: changes ? JSON.stringify(changes) : null
      })
    )
  )
  ctx.proposals.push(ID)
  await nameSession(ctx.user, ctx.sessionId, kind === 'PACKAGE' ? `Package ${spec.name || packageId}` : `${spec.name || iflowId} · ${packageId}`)
  return ID
}

/** Names the conversation after what it builds, unless the user renamed it */
async function nameSession(user, sessionId, title) {
  if (!sessionId || !title) return
  await cds.tx({ user }, async (tx) => {
    const s = await tx.run(SELECT.one.from('iflowpilot.ChatSession', sessionId).columns('title', 'titleEdited'))
    if (s && !s.titleEdited && s.title !== title) await tx.run(UPDATE('iflowpilot.ChatSession', sessionId).set({ title: title.slice(0, 200) }))
  })
}

/** The existing iFlow as a spec, or null if it does not exist: { spec, blockers, packageId } */
async function currentSpec(iflowId) {
  const iflow = await iflowExists(iflowId)
  if (!iflow) return null
  // the current parameter values are required: without them the spec would carry the defaults,
  // and approving the update would write those over the values configured on the tenant
  const [zip, configurations] = await Promise.all([
    cpi.downloadIflowZip(iflowId),
    cpi.getConfigurations(iflowId).catch((e) => {
      throw Object.assign(new Error(`The current parameter values of iFlow '${iflowId}' could not be read (${e.message}). An update needs them; try again.`), {
        code: 'CONFIGURATIONS_UNREADABLE',
        status: e.status
      })
    })
  ])
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
    // files of the conversation that replace the iFlow's: uploads of the user and scripts written with writeScript
    keptFiles: files.map((f) => f.fileName).filter((f) => !stored.has(f))
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

  async getMessageLogs({ iflowId, status, sinceHours = 24, top = 20 } = {}) {
    return cpi.listMessageLogs({ iflowId, status, sinceHours, top })
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
    if (toPackageId(spec.packageId).id) spec = { ...spec, packageId: toPackageId(spec.packageId).id } // a Name -> its ID, as CPI does
    const typed = normalizeTypes(spec) // expression without ${...} -> constant
    spec = typed.spec
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
    return { valid: true, ...(groovy.warning && { warnings: [groovy.warning] }), ...autoFixes(typed.fixes), next: 'Propose it with { "useValidatedSpec": true }; do not send the spec again.' }
  },

  async writeScript({ fileName, code }, ctx) {
    fileName = String(fileName || '').replace(/\.groovy$/, '')
    const errors = []
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fileName)) errors.push({ code: 'BAD_FORMAT', message: 'fileName: use a letter, then letters, digits or underscore (no extension)' })
    if (typeof code !== 'string' || !code.trim()) errors.push({ code: 'MISSING_FIELD', message: 'code: the complete Groovy script is missing' })
    else {
      if (!GROOVY_IMPORT.test(code)) errors.push({ code: 'GROOVY_IMPORT', message: `${fileName}.groovy: must import com.sap.gateway.ip.core.customdev.util.Message` })
      if (!GROOVY_ENTRY.test(code)) errors.push({ code: 'GROOVY_ENTRY', message: `${fileName}.groovy: must define 'def Message processData(Message message)' and return the message` })
      // the same rule as for inline code: scripts are always written here, so this is where it applies
      if (hasScriptSecret(code))
        errors.push({ code: 'SECRET', message: `${fileName}.groovy: contains a hard-coded secret — read credentials from deployed security material (SecureStoreService) instead` })
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
    const lintWarnings = groovyCheck.lint(code).map((w) => `${file}:${w.line}: ${w.message}`)
    const warnings = [...(!checked ? [`Groovy syntax not checked: ${reason}`] : []), ...lintWarnings]
    return {
      stored: file,
      lines: code.split('\n').length,
      ...(warnings.length && { warnings }),
      ...(lintWarnings.length && { lintNote: 'Rewrite your own script to stream the body; for a script the user gave, tell them and ask first.' }),
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
    // a package Name ("test_1") stays in the draft; proposing derives its ID, so it is no format error here
    const open = validate({ ...draft, packageId: toPackageId(draft.packageId).id || draft.packageId }, { attachments: Object.keys(attachments) }).issues
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

  async getSampleResponse({ url } = {}) {
    try {
      return { ...(await sampleResponse(url)), instruction: 'Write the script against this structure; access every value null-safe.' }
    } catch (e) {
      return { error: { code: e.code || 'SAMPLE_FAILED', message: e.message }, instruction: 'Write the script without a sample; access every value null-safe.' }
    }
  },

  async getPattern({ name } = {}) {
    if (!PATTERNS[name]) return { error: { code: 'UNKNOWN_PATTERN', message: `No pattern '${name}'. Use one of: ${Object.keys(PATTERNS).join(', ')}.` } }
    patternCache[name] ??= fs.readFileSync(PATTERNS[name], 'utf8')
    return { name, pattern: patternCache[name], instruction: 'Follow this pattern.' }
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
    let { spec, error } = await specToPropose(args, ctx)
    if (error) return error
    const notJson = unparsableSpec(spec)
    if (notJson) return notJson
    const pkg = await resolvePackage(spec.packageId)
    if (pkg.error) return { valid: false, errors: [pkg.error] }
    if (pkg.note) spec = { ...spec, packageId: pkg.id }
    const typed = normalizeTypes(spec) // expression without ${...} -> constant
    spec = typed.spec
    if (args.spec) await saveDraft(ctx, spec, { source: 'your latest proposeIflow' })
    const ask = await packageNotGiven(ctx, spec, pkg)
    if (ask) return ask
    const attachments = await attachmentsOf(ctx)
    const { valid, issues, warnings: specNotes } = validate(spec, { attachments: Object.keys(attachments) })
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
    if (!pkgExists && !pkg.name) {
      // the default package given as a Name ("test_1"): create it with that Name
      const defaults = await defaultsOf(ctx)
      if (defaults.packageName && defaults.packageId === spec.packageId) pkg.name = defaults.packageName
    }

    const { summary } = await build(spec, { attachments }) // proves the spec builds into a zip
    const groovy = await groovySyntax(spec, attachments)
    if (groovy.issues.length) return compactInvalid(groovy.issues, 'Fix the scripts with writeScript and propose again.')
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', spec, iflowId: spec.id, packageId: spec.packageId, packageName: pkg.name, attachments, scriptChecks: groovy.files })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      ...(groovy.warning && { warnings: [groovy.warning] }),
      ...(pkg.note && { packageIdNote: `${pkg.note} Tell the user exactly this, in one line; do not ask about it.` }),
      ...autoFixes(typed.fixes),
      ...(specNotes?.length && { specNotes }),
      summary: { trigger: summary.trigger, steps: summary.steps.map((s) => `${s.name} (${s.type})`), end: summary.end, exceptionSubprocess: summary.exceptionSubprocess, parameters: summary.parameters },
      ...(!pkgExists &&
        (pkg.name
          ? { packageNote: `Package '${spec.packageId}' does not exist yet; approving creates it with the name '${pkg.name}'.` }
          : {
              packageNote: `Package '${spec.packageId}' does not exist on the tenant. Tell the user. They choose in the proposal panel: use an existing package or create '${spec.packageId}' with a name. Mention the similar packages, if any.`,
              similarPackages: await similarPackages(spec.packageId)
            })),
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
    const { spec, attachedFiles, keptFiles } = await detachFiles(ctx, current.spec, current.resources)
    await saveDraft(ctx, spec, { source: `current content of iFlow ${iflowId}` })
    return {
      editable: true,
      spec,
      ...(attachedFiles.length && { attachedFiles }),
      ...(keptFiles.length && { keptFiles }),
      instruction:
        'Change only what the user asked for, keep everything else as it is, edit the draft with editDraftSpec and call proposeIflowUpdate with { "useDraftSpec": true }. Scripts and XSLT files are attached files: keep their steps without code' +
        (keptFiles.length ? `; ${keptFiles.join(', ')} (uploaded by the user or written with writeScript in this conversation) replace the iFlow's current files.` : '.')
    }
  },

  async proposeIflowUpdate(args, ctx) {
    let { spec, error } = await specToPropose(args, ctx)
    if (error) return error
    const notJson = unparsableSpec(spec)
    if (notJson) return notJson
    const typed = normalizeTypes(spec) // expression without ${...} -> constant
    spec = typed.spec
    if (args.spec) await saveDraft(ctx, spec, { source: 'your latest proposeIflowUpdate' })
    const attachments = await attachmentsOf(ctx)
    const { valid, issues } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix only what these errors name and propose again.')
    const current = await currentSpec(spec.id)
    if (!current) return { valid: false, errors: [`id: iFlow '${spec.id}' does not exist — use proposeIflow to create a new iFlow`] }
    if (current.packageId !== spec.packageId)
      return { valid: false, errors: [`packageId: iFlow '${spec.id}' is in package '${current.packageId}' — an update keeps the package, set packageId to '${current.packageId}'`] }
    if (current.blockers.length) return { valid: false, errors: current.blockers.map((b) => `not updatable: ${b}`), instruction: 'Tell the user this iFlow cannot be updated here, and why.' }

    // Scripts: the proposal's file against the iFlow's current code
    const currentCode = Object.fromEntries(
      [...current.spec.steps, ...(current.spec.exceptionSubprocess?.steps || [])].filter((s) => s.type === 'groovyScript').map((s) => [`${s.fileName}.groovy`, s.code])
    )
    const scripts = Object.fromEntries(
      [...spec.steps, ...(spec.exceptionSubprocess?.steps || [])]
        .filter((s) => s.type === 'groovyScript')
        .map((s) => `${s.fileName}.groovy`)
        .map((f) => [f, currentCode[f] == null ? 'new' : attachments[f] === currentCode[f] ? 'unchanged' : 'changed'])
    )
    // The user sent code but every script stays as it is: the model did not write it (or it was lost)
    if (GROOVY_IN_TEXT.test(ctx.message || '') && Object.keys(scripts).length && Object.values(scripts).every((v) => v === 'unchanged'))
      return {
        valid: false,
        errors: [
          `SCRIPT_UNCHANGED ${Object.keys(scripts).join(', ')}: the user's message contains Groovy code, but this update keeps the iFlow's scripts unchanged. Write the user's code with writeScript (same fileName) exactly as given, then propose again. Do not change other fields to get past this.`
        ]
      }

    // steps are compared without script code (fileName only): a script change is reported once, as the script
    const withoutCode = (sp) => {
      const strip = (steps = []) => steps.map(({ code, ...s }) => s)
      return { ...sp, resources: undefined, steps: strip(sp.steps), ...(sp.exceptionSubprocess && { exceptionSubprocess: { ...sp.exceptionSubprocess, steps: strip(sp.exceptionSubprocess.steps) } }) }
    }
    // both sides typed alike, so rows the user did not touch are not reported as changed …
    const currentTyped = normalizeTypes(current.spec)
    const changes = describeChanges(withoutCode(currentTyped.spec), withoutCode(spec))
    // … but the iFlow's own plain-value expressions do become constants: say so
    if (currentTyped.fixes.length) changes.push(`type expression -> constant (the value has no \${...}): ${currentTyped.fixes.join(', ')}`)
    if (JSON.stringify(current.spec.resources || []) !== JSON.stringify(spec.resources || [])) changes.push('XSLT files changed')
    for (const f of spec.resources || []) if (current.resources?.[f] != null && current.resources[f] !== attachments[f]) changes.push(`${f} replaced`)
    for (const [f, status] of Object.entries(scripts)) if (status !== 'unchanged') changes.push(`script ${f} ${status === 'new' ? 'added' : 'changed'}`)
    if (!changes.length) return { valid: false, errors: ['NO_CHANGE spec: nothing changed compared to the current iFlow'] }
    const { summary } = await build(spec, { attachments })
    const groovy = await groovySyntax(spec, attachments)
    if (groovy.issues.length) return compactInvalid(groovy.issues, 'Fix the scripts with writeScript and propose again.')
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', operation: 'UPDATE', spec, iflowId: spec.id, packageId: spec.packageId, attachments, scriptChecks: groovy.files, changes: { list: changes, scripts } })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      ...(groovy.warning && { warnings: [groovy.warning] }),
      operation: 'UPDATE',
      changes,
      scripts,
      summary: { trigger: summary.trigger, steps: summary.steps.map((s) => `${s.name} (${s.type})`), end: summary.end, exceptionSubprocess: summary.exceptionSubprocess, parameters: summary.parameters },
      instruction:
        'Tell the user the update is ready for review in the proposal panel. Do not list the changes yourself: the app adds the actual changes (the list above, per script changed or unchanged) below your answer, and never claim a change that is not in that list. Mention: approving replaces the iFlow content after backing it up (stored with the proposal and saved as a CPI version; "Restore previous version" on the iFlows page puts it back), and a deployed iFlow runs the old version until they approve with deploy. Nothing has changed yet.'
    }
  },

  async proposePackage({ id, name, shortText }, ctx) {
    const pkg = await resolvePackage(id, 'id')
    if (pkg.error) return { valid: false, errors: [pkg.error] }
    id = pkg.id
    name ||= pkg.name
    const errors = []
    if (!id) errors.push('id: required (letters, digits and dots)')
    if (!name) errors.push('name: required')
    if (errors.length) return { valid: false, errors }
    if (await packageExists(id)) return { valid: false, errors: [`id: package '${id}' already exists — use it instead of proposing a new one`] }
    const proposalId = await storeProposal(ctx, { kind: 'PACKAGE', spec: { id, name, shortText: shortText || name }, packageId: id })
    return {
      valid: true,
      proposalId,
      status: 'PENDING',
      ...(pkg.note && { packageIdNote: `${pkg.note} Tell the user exactly this, in one line; do not ask about it.` }),
      instruction: 'Tell the user the package proposal is ready for review. Nothing has been created yet.'
    }
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
  const useDraft = useDraftSpec === true || useDraftSpec === 'true'
  const useValidated = useValidatedSpec === true || useValidatedSpec === 'true'
  // a spec sent without the "spec" wrapper; not when the draft or validated spec is asked for: a stray
  // field next to { "useDraftSpec": true } (e.g. "id") would otherwise replace the draft with a stub
  const unwrapped = rest.spec === undefined && !useDraft && !useValidated && (rest.steps || rest.trigger)
  let spec = unwrapped ? rest : parseJsonString(rest.spec)
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    spec = { ...spec }
    for (const f of SPEC_OBJECT_FIELDS) if (f in spec) spec[f] = parseJsonString(spec[f])
  }
  return { spec, useValidatedSpec: useValidated, useDraftSpec: useDraft }
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

module.exports = { definitions, execute, nameSession, normalizeSpecArgs }
