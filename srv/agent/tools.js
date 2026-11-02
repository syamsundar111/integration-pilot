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
const { sampleResponse } = require('../lib/sample-response')
const { parse } = require('../iflow-builder/parser')
const { specFromParsed, describeChanges } = require('../iflow-builder/to-spec')
const { allSteps, mapSteps } = require('../iflow-builder/spec-steps')

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
const { toPackageId, IMPORT_NO_PACKAGE } = require('../lib/package-id')

// Topics: steps whose format and rules are sent only when a conversation needs them (srv/agent/prompt-sections/<topic>.md);
// the getSupportedSteps tool lists them from here (enum and description), so a new topic cannot be missed there
const TOPICS = {
  routing: { steps: ['router'], label: 'router', summary: 'router: branch into routes by conditions (route ends, joins)' },
  splitting: { steps: ['splitter', 'gather', 'processCall'], label: 'splitter, gather, process calls, local processes', summary: 'splitter / gather: steps per item; local processes run by a processCall (also looping)' },
  soap: { steps: ['requestReplySoap'], label: 'SOAP 1.x call', summary: 'requestReplySoap: a SOAP 1.x call' },
  mail: { steps: ['sendMail'], label: 'send a mail', summary: 'sendMail: send a mail, one-way' },
  mapping: { steps: ['messageMapping', 'xsltMapping'], label: 'message mapping, XSLT', summary: 'messageMapping (an artifact) and xsltMapping (an attached file)' },
  multicast: { steps: ['multicast'], label: 'multicast and join', summary: 'multicast: send the message down several branches, in parallel or in sequence; a gather combines them after the Join' },
  senders: { steps: [], triggers: ['soapSender', 'processDirectSender', 'jmsSender', 'sftpSender'], label: 'SOAP, ProcessDirect, JMS and SFTP senders', summary: 'senders: soapSender (SOAP 1.x, XML in and out), processDirectSender (called by other iFlows on the tenant), jmsSender (reads a queue), sftpSender (polls files on an SFTP server)' }
}
for (const [t, def] of Object.entries(TOPICS)) def.rules = () => fs.readFileSync(path.join(__dirname, 'prompt-sections', `${t}.md`), 'utf8').trim()

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
  fn(
    'getSupportedSteps',
    `Spec format in short, with an example. Call once before proposing. topics: also the format and rules of ${Object.entries(TOPICS)
      .map(([t, def]) => `${t} (${def.label})`)
      .join(', ')} when you need them. full: the JSON schema (rarely needed).`,
    { topics: { type: 'array', items: { type: 'string', enum: Object.keys(TOPICS) } }, full: { type: 'boolean' } }
  ),
  fn('validateSpec', 'Check a spec without proposing it; only after a failed proposal. Returns { valid } or errors "CODE path: message".', {
    spec: { type: 'object' },
    useDraftSpec: { type: 'boolean', description: 'validate the draft spec' }
  }),
  fn(
    'writeScript',
    'Write or replace one Groovy script (plain code). Steps use it by fileName, without code.',
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

/**
 * The spec format in short (getSupportedSteps); test/agent.test.js keeps it in line with spec-schema.json. The steps
 * of a topic (TOPICS) are only sent when the conversation needs them, like the prompt section of the same name.
 */
const SPEC_FORMAT = {
  spec: '{ id, name, description?, packageId, trigger, steps: [step] (max 50 per process, counting route steps), end, exceptionSubprocess?, localProcesses?, parameters?, resources? }',
  trigger: ['{ "type": "httpsSender", "address": "/path/segments" }', '{ "type": "soapSender", "address": "/path/segments" } (SOAP 1.x, XML in and out)', '{ "type": "processDirectSender", "address": "/path/segments" } (called by other iFlows on the tenant)', '{ "type": "jmsSender", "queue": "QUEUE_NAME" } (the queue name the user gives)', '{ "type": "sftpSender", "host", "directory", "fileName", "authentication", "postProcessing", "minutes": 15 } (the senders topic)', '{ "type": "timer", "mode": "once" }', '{ "type": "timer", "mode": "every", "minutes": 15 } (UTC, all day)'],
  steps: {
    contentModifier:
      '{ type, name?, description?, headers?: [entry], properties?: [entry], body?: string }; entry = { name, type: constant|expression|header|property|xpath|globalVariable|localVariable, value (a constant may be "{{Param}}"), datatype? (xpath: default java.lang.String), default? (the Default Value column, only when asked for explicitly) }',
    groovyScript: '{ type, name?, description?, fileName } — code written with writeScript (or attached), never in the spec',
    jsonToXml: '{ type, name?, description? }',
    xmlToJson: '{ type, name?, description? }',
    writeVariables: '{ type, name?, description?, variables: [{ name, type: property|xpath, value, datatype? (xpath), global? (Global Scope, default false) }] } — main flow only',
    router:
      '{ type, name?, description?, expressionType: XML|NonXML, routes: [{ name, condition (XPath, or ${…} with spaces around the operator), steps?: [step], end?: { event: message|escalation|error, name?, category? (escalation: Others|RoutingConditionNotMet) } }, …, { name, default: true, steps?, end? } (last)] } — main line only; a route without end continues with the step after the router; if every route ends, the router is the last step and end is { "type": "none" }',
    requestReplyHttp:
      '{ type, name?, description?, system?, url: "https://…" | "{{Param}}", method: GET|POST|PUT|PATCH|DELETE, authType: None|Basic|"OAuth2 Client Credentials", credentialName? (deployed credential name or "{{Param}}", never a secret; required unless None), proxyType?: Internet|On-Premise, locationId? (On-Premise only; name or "{{Param}}"), timeout? (ms, default 60000) }',
    splitter:
      '{ type, name?, description?, kind: iterating|general, expression (XPath, e.g. //order), grouping? (1), streaming? (true), stopOnException: true|false (always set), parallel?: false } — main line; the next steps run per item until a gather or the end (no nested split, no router before the gather: route in a called local process); properties set per item are lost after the gather',
    gather: '{ type, name?, description?, source?, target? } — closes a split: Combine; with source (XPath, e.g. //order) and target (e.g. /orders): Combine at XPath',
    processCall: '{ type, name?, description?, process (localProcesses name), loop?: { condition (as NonXML), max } } — main line, routes, branches, exceptionSubprocess',
    multicast:
      '{ type, name?, description?, mode: parallel|sequential, join? (name of the Join, which the builder adds), branches: [{ name?, steps: [step] }] (2-20) } — main line only; the next step must be a gather with only a name. Every branch reaches the Join: no multicast in a branch, a router in a branch has exactly one continuing route (the others end) and no gather after it, a splitter in a branch has its gather there',
    requestReplySoap: '{ type, name?, description?, system?, url ("{{Param}}" allowed), authType: Basic, credentialName, proxyType: On-Premise, locationId?, timeout? } — no WSDL: the body is sent as it is; not in exceptionSubprocess',
    messageMapping: '{ type, name?, description?, mapping (artifact id) } — or file (.mmap) and schemas from an imported or existing iFlow, never written by you',
    xsltMapping: '{ type, name?, description?, file (an attached .xsl) }',
    sendMail: '{ type, name?, description?, system?, server (host:port), credentialName, from, to (comma-separated), cc?, bcc?, subject, body? (default ${in.body}) } — one-way; server, credentialName, to may be "{{Param}}"; also in exceptionSubprocess'
  },
  end: ['{ "type": "none", event?: message|escalation|error, category? (escalation: Others|RoutingConditionNotMet) }', '{ "type": "httpReceiver", system?, url, method, authType, credentialName?, proxyType?, locationId?, timeout? } (as requestReplyHttp)'],
  exceptionSubprocess: '{ name?, steps: 1-10 of contentModifier | groovyScript | jsonToXml | xmlToJson | processCall | sendMail, end?: { event: message|escalation|error, name?, category? } (new iFlows: escalation or error) }',
  localProcesses: '[{ name, description?, steps: [step] (routers as on the main line, route ends only { event: message }, which returns to the caller; no splitter, gather, processCall) }]',
  parameters: '{ "Name": "default value" } — used only as a whole receiver url, credentialName or locationId, a mail server or to, or a constant header/property value "{{Name}}"',
  resources: '[ "file.xsl" ] — attached XSLT files no step uses, added as mapping/<file>',
  names: 'id: letters, digits, _ · packageId: letters, digits, dots (a Name with _ or spaces is turned into the ID) · fileName, system: letter first, then letters, digits, _ · step names unique'
}

/**
 * Message Mapping artifacts a spec refers to, checked on the tenant: { issues, notes }. A missing one cannot be
 * approved successfully. Another package gets a note: it is not known whether the editor lists those artifacts.
 */
async function checkMappingArtifacts(spec) {
  const ids = [...new Set(allSteps(spec).map((x) => x.step).filter((s) => s?.type === 'messageMapping' && s.mapping).map((s) => s.mapping))]
  const issues = []
  const notes = []
  for (const id of ids) {
    let artifact
    try {
      artifact = await cpi.getMessageMapping(id)
    } catch {
      notes.push(`The Message Mapping artifact ${id} could not be checked on the tenant; make sure it exists and is deployed.`)
      continue
    }
    if (!artifact) issues.push({ code: 'MAPPING_NOT_FOUND', message: `messageMapping: no Message Mapping artifact '${id}' on the tenant` })
    else if (artifact.packageId !== spec.packageId) notes.push(`The Message Mapping artifact ${id} is in package ${artifact.packageId}, the iFlow in ${spec.packageId}; check in the CPI editor that it can be selected.`)
  }
  return { issues, notes }
}
const MAPPING_INSTRUCTION = 'Never invent a mapping: replace each such step with a placeholder Content Modifier PH_<StepName> (description starting REPLACE WITH, one constant property REPLACE_WITH), propose again and tell the user which artifact is missing.'


/** The conditional prompt sections a conversation has (agent.js promptSections) */
async function sessionSections(ctx) {
  if (!ctx.sessionId) return []
  const row = await cds.tx({ user: ctx.user }, (tx) => tx.run(SELECT.one.from('iflowpilot.ChatSession', ctx.sessionId).columns('promptSections')))
  return row?.promptSections ? JSON.parse(row.promptSections) : []
}

/** Adds sections to a conversation, so they are in the prompt from the next model call on */
async function addSessionSections(ctx, names) {
  if (!ctx.sessionId) return
  const all = [...new Set([...(await sessionSections(ctx)), ...names])]
  await cds.tx({ user: ctx.user }, (tx) => tx.run(UPDATE('iflowpilot.ChatSession', ctx.sessionId).set({ promptSections: JSON.stringify(all) })))
}

/** Validation result for the model: codes and short messages, never the spec itself */
function compactInvalid(issues, instruction) {
  const errors = issues.slice(0, MAX_ERRORS).map((i) => `${i.code} ${i.message}`)
  if (issues.length > MAX_ERRORS) errors.push(`… ${issues.length - MAX_ERRORS} more; fix these first`)
  return { valid: false, errors, ...(instruction && { instruction }) }
}

/**
 * The refusal for an iFlow that exists already, and a note for the answer if the model proposes
 * another id anyway (ctx.duplicates, used by the agent when it finishes the turn)
 */
function duplicateIflow(ctx, spec, existing, by) {
  const found = { name: existing.name || existing.id, id: existing.id, packageId: existing.packageId || spec.packageId }
  ;(ctx.duplicates ??= []).push({ ...found, proposedId: spec.id, proposedName: spec.name })
  return {
    valid: false,
    errors: [
      by === 'id'
        ? `IFLOW_EXISTS id: an iFlow '${found.id}' ("${found.name}") already exists in package '${found.packageId}'`
        : `IFLOW_EXISTS name: package '${found.packageId}' already has an iFlow named "${found.name}" (id '${found.id}')`
    ],
    instruction:
      `Do not choose another id or name on your own. Tell the user that "${found.name}" (id ${found.id}) already exists in package ${found.packageId}, ` +
      'and ask: update the existing iFlow (then call getIflowSpec and proposeIflowUpdate), or create a new iFlow, and with which name? ' +
      `Suggest a name ("${found.name} 2"); if they agree ("okay", "yes"), use it without asking again. Propose nothing until they answer.`
  }
}

/**
 * A list sent as a JSON string that does not parse: the parse error and the text around it, instead of
 * "send a list" (the model resent the same broken string 8 times when it was not told what is wrong)
 */
function brokenJson(field, value) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return null
  try {
    JSON.parse(value)
    return null
  } catch (e) {
    const at = Number(/position (\d+)/.exec(e.message)?.[1])
    const near = Number.isFinite(at) ? ` near …${value.slice(Math.max(0, at - 60), at + 20)}…` : ''
    return compactInvalid(
      [{ code: 'NOT_JSON', message: `${field}: sent as a string that is not valid JSON (${e.message})${near}` }],
      `Send ${field} as a JSON array, not as a string, and check the brackets. Put lookup tables and other JSON values into a Groovy script, not into a property value.`
    )
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

const wordPattern = (word) => `(?<![a-z0-9_.])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_]|\\.[a-z0-9])`
const isNamed = (text, word) => new RegExp(wordPattern(word)).test(text)
/** "package X", "package id: X", "new package called 'X'", "X package" */
const isNamedPackage = (text, word) =>
  new RegExp(`\\bpackage\\b(?:\\s+(?:with|id|name|named|called))*\\s*[:=]?\\s*["“'\`]?${wordPattern(word)}|${wordPattern(word)}["”'\`]?\\s+package\\b`).test(text)

/**
 * The target package when the user names none: the first package on the tenant, in CPI's order. The
 * proposal goes on with it (no question to the user); they change it, or create a new package, in the
 * proposal panel. Named = the package's id or name is a whole word in a message of the user in this
 * conversation (for a package that does not exist yet: right after or before the word "package", since
 * approving creates it), or an earlier proposal of this conversation used it. A tenant without packages
 * has nothing to default to: ask. AGENT_DEFAULT_PACKAGE=false keeps the model's package (tests).
 * @returns {Promise<{ packageId: string, note: string }|{ ask: string }|null>} null: keep the spec's package
 */
async function defaultPackage(ctx, spec, pkg) {
  if (process.env.AGENT_DEFAULT_PACKAGE === 'false') return null
  const packages = await cpi.listPackages().catch(() => [])
  const rows = ctx.sessionId
    ? await cds.tx({ user: ctx.user }, (tx) => tx.run(SELECT.from('iflowpilot.ChatMessage').columns('content').where({ session_ID: ctx.sessionId, role: 'user' })))
    : []
  const text = [ctx.message || '', ...rows.map((m) => m.content || '')].join('\n').toLowerCase()
  const existing = packages.find((p) => p.id === spec.packageId)
  const named = [spec.packageId, pkg?.name, existing?.name].filter(Boolean).some((n) => (existing ? isNamed : isNamedPackage)(text, String(n).toLowerCase()))
  if (named) return null
  if (ctx.sessionId && (await cds.tx({ user: ctx.user }, (tx) => tx.run(SELECT.one.from('iflowpilot.Proposal').columns('ID').where({ session_ID: ctx.sessionId, packageId: spec.packageId })))))
    return null // the package of an earlier proposal of this conversation
  if (!packages.length) return { ask: 'No package was named and none could be read from the tenant.' }
  const first = packages[0]
  if (first.id === spec.packageId) return null
  return {
    packageId: first.id,
    note: `No package was named, so the first package on the tenant is used: ${first.id} ("${first.name}"). Tell the user this in one line, and that they can pick another package or create a new one in the proposal panel before approving.`
  }
}

/** The refusal for a proposal without a target package: the user chooses, the model never picks or invents one */
async function askForPackage(why) {
  const packages = await cpi.listPackages().catch(() => [])
  return {
    valid: false,
    errors: [`PACKAGE_REQUIRED ${why}`],
    ...(packages.length && { packages: packages.slice(0, 20).map(({ id, name }) => ({ id, name })) }),
    instruction:
      'Nothing was proposed. Do not choose or invent a package. If the user named one in this conversation, set it with editDraftSpec {"op":"set","fields":{"packageId":"<id>"}} and call proposeIflow with { "useDraftSpec": true }. Otherwise ask the user which package to use, offering the packages listed here, and wait for the answer.'
  }
}

/** Tool-result field for the fixes the assistant must mention: type fixes, and an iFlow id made from the name */
const autoFixes = (fixes, other = []) => {
  const all = [...(fixes.length ? [`type expression -> constant (the value has no \${...}): ${fixes.join(', ')}`] : []), ...other]
  return all.length ? { autoFixes: all, autoFixNote: 'Tell the user these fixes in one line.' } : {}
}

/** An iFlow id from a name or a given id, as Import makes it: letters, digits and _ only, a letter first, at most 100 characters */
function iflowIdOf(s) {
  const id = String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return (/^[A-Za-z]/.test(id) ? id : `iFlow${id ? `_${id}` : ''}`).slice(0, 100)
}

/** The ids the user gave explicitly in the conversation: "id X", "iFlow ID: X", "iflow-id = X" */
async function idsGivenByUser(ctx) {
  const rows = ctx.sessionId
    ? await cds.tx({ user: ctx.user }, (tx) => tx.run(SELECT.from('iflowpilot.ChatMessage').columns('content').where({ session_ID: ctx.sessionId, role: 'user' })))
    : []
  const text = [ctx.message || '', ...rows.map((m) => m.content || '')].join('\n')
  return [...text.matchAll(/\b(?:iflow[ -]?)?id\b\s*(?:is\s*)?[:=]?\s*[`"']?([^\s`"',;]+)/gi)].map((m) => m[1].replace(/[.)]+$/, ''))
}

/**
 * A new iFlow's id is made from its name, so the model cannot take it from another answer (e.g. a queue name).
 * Kept: an id equal to the one made from the name, an id the user gave explicitly (through the same character rule),
 * and the id Import gave the draft (X_Imported differs from the name on purpose).
 * @returns {{ spec: object, fix?: string }}
 */
async function newIflowId(ctx, spec) {
  if (!spec || typeof spec !== 'object' || (typeof spec.id !== 'string' && typeof spec.name !== 'string')) return { spec }
  const fromName = iflowIdOf(spec.name || spec.id)
  if (spec.id === fromName) return { spec }
  const draft = await draftOf(ctx)
  if (draft?.importId && spec.id === draft.importId) return { spec }
  const given = (await idsGivenByUser(ctx)).find((g) => g === spec.id || iflowIdOf(g) === spec.id)
  const id = given ? iflowIdOf(given) : fromName
  if (id === spec.id) return { spec }
  const why = given ? 'the id the user gave, with only letters, digits and _' : 'made from the name; the user gave no id'
  return { spec: { ...spec, id }, fix: `id ${spec.id || '(none)'} -> ${id} (${why})` }
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
  const importId = (await draftOf(ctx))?.importId // the id Import chose stays known while the draft changes
  const draft = { spec, source, valid, at: new Date().toISOString(), ...(importId && { importId }) }
  await cds.tx({ user: ctx.user }, (tx) => tx.run(UPDATE('iflowpilot.ChatSession', ctx.sessionId).set({ draftSpec: JSON.stringify(draft) })))
}

/** Stores a PENDING proposal in its own transaction, so it survives a failing chat turn */
async function storeProposal(ctx, { kind, spec, iflowId = null, packageId = null, packageName = null, operation = 'CREATE', attachments = {}, changes = null }) {
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

/** File names used by proposals or the draft of other iFlows in this conversation */
async function filesOfOtherIflows(ctx, iflowId) {
  if (!ctx.sessionId) return new Set()
  const proposals = await cds.tx({ user: ctx.user }, (tx) =>
    tx.run(SELECT.from('iflowpilot.Proposal').columns('iflowId', 'attachments').where({ session_ID: ctx.sessionId, iflowId: { '!=': iflowId } }))
  )
  const names = proposals.flatMap((p) => Object.keys(p.attachments ? JSON.parse(p.attachments) : {}))
  const draft = (await draftOf(ctx))?.spec
  if (draft && draft.id !== iflowId)
    for (const { step: s } of allSteps(draft)) if (s?.type === 'groovyScript' && s.fileName) names.push(`${s.fileName}.groovy`)
  return new Set(names)
}

/**
 * Moves the scripts and XSLT files of an existing iFlow's spec into the conversation's
 * attachments and returns the spec without code, so the model never receives script bodies.
 * An upload of the user with the same name is kept: it replaces the iFlow's file.
 */
async function detachFiles(ctx, spec, resources = {}) {
  const steps = allSteps(spec)
    .map((x) => x.step)
    .filter((s) => s?.type === 'groovyScript' && s.code != null)
  const files = [...steps.map((s) => ({ fileName: `${s.fileName}.groovy`, content: s.code })), ...Object.entries(resources).map(([fileName, content]) => ({ fileName, content }))]
  // a script written earlier with writeScript wins (the model may write the new version before loading
  // the iFlow), unless it belongs to another iFlow of this conversation: then this iFlow's file is loaded
  const otherIflows = files.length ? await filesOfOtherIflows(ctx, spec.id) : new Set()
  const replaceAi = files.map((f) => f.fileName).filter((f) => otherIflows.has(f))
  const stored = new Set(files.length ? await attachmentStore.save(ctx.user, ctx.sessionId, files, 'iflow', { replaceAi }) : [])
  ctx.attachments = undefined // reload: new files
  return {
    spec: mapSteps(spec, (s) => (s.type === 'groovyScript' && s.code != null ? (({ code, ...rest }) => rest)(s) : s)),
    attachedFiles: files.map((f) => f.fileName).filter((f) => stored.has(f)),
    // files of the conversation that replace the iFlow's: uploads of the user and scripts written with writeScript
    keptFiles: files.map((f) => f.fileName).filter((f) => !stored.has(f)),
    // scripts of another iFlow with the same name: this iFlow's current file is loaded instead
    replacedScripts: replaceAi
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

  async getSupportedSteps({ full, topics = [] } = {}, ctx = {}) {
    // The compact format is enough to write a spec and is about a quarter of the schema's size; it is
    // re-sent with every later model call of the message, so its size counts several times. Steps of a
    // topic come only when the conversation uses it (its prompt section) or the model asks for it.
    const inPrompt = await sessionSections(ctx)
    const wanted = Object.keys(TOPICS).filter((t) => topics.includes(t) && !inPrompt.includes(t))
    if (wanted.length) await addSessionSections(ctx, wanted) // sticky, as if the conversation had asked for it
    const active = Object.keys(TOPICS).filter((t) => inPrompt.includes(t) || wanted.includes(t))
    const hidden = new Set(Object.entries(TOPICS).flatMap(([t, def]) => (active.includes(t) ? [] : def.steps)))
    const hiddenTriggers = Object.entries(TOPICS).flatMap(([t, def]) => (active.includes(t) ? [] : def.triggers || []))
    const format = {
      ...SPEC_FORMAT,
      trigger: SPEC_FORMAT.trigger.filter((f) => !hiddenTriggers.some((type) => f.includes(`"type": "${type}"`))),
      steps: Object.fromEntries(Object.entries(SPEC_FORMAT.steps).filter(([type]) => !hidden.has(type))),
      ...(!active.includes('splitting') && { localProcesses: undefined })
    }
    const more = Object.keys(TOPICS).filter((t) => !active.includes(t))
    return {
      ...(full ? { schema: { ...schema, examples: undefined } } : { format }),
      ...(wanted.length && { rules: Object.fromEntries(wanted.map((t) => [t, TOPICS[t].rules()])) }),
      ...(more.length && { moreTopics: Object.fromEntries(more.map((t) => [t, TOPICS[t].summary])) }),
      example: schema.examples[0],
      notes: [
        'Flows run trigger -> steps in order -> end; a router step branches into routes that end or continue with the next step. Error handling goes into the optional top-level exceptionSubprocess (not into steps).',
        'exceptionSubprocess runs when a step fails; ${exception.message} holds the error text. An error response to an HTTPS sender only when the user asks for one (see the base prompt).',
        'To change an existing iFlow: getIflowSpec, change the spec, proposeIflowUpdate. Never use proposeIflow with an existing id.',
        'HTTP receivers: authType None, Basic or OAuth2 Client Credentials with credentialName (the name of deployed security material, never a password); proxyType Internet or On-Premise (locationId optional); timeout in ms.',
        'Externalized parameters ({{Name}}) are only supported as the whole url, credentialName or locationId of an HTTP receiver, or as a constant header/property value; define each in "parameters".',
        'Groovy: import com.sap.gateway.ip.core.customdev.util.Message and define def Message processData(Message message).',
        'Write every Groovy script with writeScript (plain code), then reference it in the spec by fileName without code; never put Groovy code into a spec.',
        'Send the complete spec in one proposeIflow call (it validates). Only when an answer was cut off for length: build the draft with editDraftSpec (set, then addSteps with at most 8 steps per call) and propose { useDraftSpec: true }; fix single steps with replaceStep.'
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
    const idFix = await newIflowId(ctx, typed.spec)
    spec = idFix.spec
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
    ctx.validatedSpec = spec
    await saveDraft(ctx, spec, { source, valid: true })
    return { valid: true, ...autoFixes(typed.fixes, idFix.fix ? [idFix.fix] : []), next: 'Propose it with { "useValidatedSpec": true }; do not send the spec again.' }
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
    await attachmentStore.save(ctx.user, ctx.sessionId, [{ fileName: file, content: code }], 'ai')
    ctx.attachments = undefined // reload: new content
    ;(ctx.written ??= []).push(file)
    return {
      stored: file,
      lines: code.split('\n').length,
      next: `Use it with { "type": "groovyScript", "fileName": "${fileName}" } and no "code".`
    }
  },

  async editDraftSpec({ ops }, ctx) {
    const broken = brokenJson('ops', ops)
    if (broken) return broken
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
    if (spec.packageId === IMPORT_NO_PACKAGE) return askForPackage('The imported iFlow has no target package yet.')
    let pkg = await resolvePackage(spec.packageId)
    if (pkg.error) return { valid: false, errors: [pkg.error] }
    if (pkg.note) spec = { ...spec, packageId: pkg.id }
    // no package named by the user: the first package on the tenant (changeable in the proposal panel)
    const chosen = await defaultPackage(ctx, spec, pkg)
    if (chosen?.ask) return askForPackage(chosen.ask)
    if (chosen) {
      spec = { ...spec, packageId: chosen.packageId }
      pkg = { id: chosen.packageId }
    }
    const typed = normalizeTypes(spec) // expression without ${...} -> constant
    const idFix = await newIflowId(ctx, typed.spec)
    spec = idFix.spec
    if (args.spec || chosen || idFix.fix) await saveDraft(ctx, spec, { source: 'your latest proposeIflow' })
    const attachments = await attachmentsOf(ctx)
    const { valid, issues, warnings } = validate(spec, { attachments: Object.keys(attachments) })
    if (!valid) return compactInvalid(issues, 'Fix only what these errors name and propose again.')
    const artifacts = await checkMappingArtifacts(spec)
    if (artifacts.issues.length) return compactInvalid(artifacts.issues, MAPPING_INSTRUCTION)
    const specNotes = [...(warnings || []), ...artifacts.notes]

    // Fail early on things the user could not approve successfully. An iFlow that exists already (same
    // id anywhere, or the same name in the target package) is the user's decision: update it or create
    // another one with another name; the model must ask, not rename on its own
    const existing = await iflowExists(spec.id)
    if (existing) return duplicateIflow(ctx, spec, existing, 'id')
    const pkgExists = await packageExists(spec.packageId)
    if (pkgExists) {
      const sameName = (await cpi.listIflows(spec.packageId)).find((f) => String(f.name || '').trim().toLowerCase() === String(spec.name || '').trim().toLowerCase())
      if (sameName) return duplicateIflow(ctx, spec, sameName, 'name')
    }
    const { summary } = await build(spec, { attachments }) // proves the spec builds into a zip
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', spec, iflowId: spec.id, packageId: spec.packageId, packageName: pkg.name, attachments })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
      ...(pkg.note && { packageIdNote: `${pkg.note} Tell the user exactly this, in one line; do not ask about it.` }),
      ...(chosen && { packageDefault: chosen.note }),
      ...autoFixes(typed.fixes, idFix.fix ? [idFix.fix] : []),
      // notes for the user: the proposal is stored as it is, a note is never a reason to change a value
      ...(specNotes?.length && {
        specNotes,
        specNotesUse: 'Information for the user, at most one line in your answer. The proposal is stored as it is: never change a value the user asked for because of these notes.'
      }),
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
    const { spec, attachedFiles, keptFiles, replacedScripts } = await detachFiles(ctx, current.spec, current.resources)
    await saveDraft(ctx, spec, { source: `current content of iFlow ${iflowId}` })
    return {
      editable: true,
      spec,
      ...(attachedFiles.length && { attachedFiles }),
      ...(keptFiles.length && { keptFiles }),
      ...(replacedScripts.length && {
        replacedScripts,
        replacedNote: `${replacedScripts.join(', ')}: the script of that name you wrote for another iFlow was replaced by this iFlow's current file. To change this iFlow's script, write it again with writeScript.`
      }),
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
    const artifacts = await checkMappingArtifacts(spec)
    if (artifacts.issues.length) return compactInvalid(artifacts.issues, MAPPING_INSTRUCTION)
    const current = await currentSpec(spec.id)
    if (!current) return { valid: false, errors: [`id: iFlow '${spec.id}' does not exist — use proposeIflow to create a new iFlow`] }
    if (current.packageId !== spec.packageId)
      return { valid: false, errors: [`packageId: iFlow '${spec.id}' is in package '${current.packageId}' — an update keeps the package, set packageId to '${current.packageId}'`] }
    if (current.blockers.length) return { valid: false, errors: current.blockers.map((b) => `not updatable: ${b}`), instruction: 'Tell the user this iFlow cannot be updated here, and why.' }

    // Scripts: the proposal's file against the iFlow's current code
    const currentCode = Object.fromEntries(
      allSteps(current.spec)
        .map((x) => x.step)
        .filter((s) => s.type === 'groovyScript')
        .map((s) => [`${s.fileName}.groovy`, s.code])
    )
    const scripts = Object.fromEntries(
      allSteps(spec)
        .map((x) => x.step)
        .filter((s) => s?.type === 'groovyScript')
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
    const withoutCode = (sp) => ({ ...mapSteps(sp, ({ code, ...s }) => s), resources: undefined })
    // both sides typed alike, so rows the user did not touch are not reported as changed …
    const currentTyped = normalizeTypes(current.spec)
    const changes = describeChanges(withoutCode(currentTyped.spec), withoutCode(spec))
    // … but the iFlow's own plain-value expressions do become constants: say so
    if (currentTyped.fixes.length) changes.push(`type expression -> constant (the value has no \${...}): ${currentTyped.fixes.join(', ')}`)
    if (JSON.stringify(current.spec.resources || []) !== JSON.stringify(spec.resources || [])) changes.push('XSLT files changed')
    for (const f of attachmentStore.referencedBy(spec).filter((x) => !/\.groovy$/.test(x))) if (current.resources?.[f] != null && current.resources[f] !== attachments[f]) changes.push(`${f} replaced`)
    for (const [f, status] of Object.entries(scripts)) if (status !== 'unchanged') changes.push(`script ${f} ${status === 'new' ? 'added' : 'changed'}`)
    if (!changes.length) return { valid: false, errors: ['NO_CHANGE spec: nothing changed compared to the current iFlow'] }
    const { summary } = await build(spec, { attachments })
    const proposalId = await storeProposal(ctx, { kind: 'IFLOW', operation: 'UPDATE', spec, iflowId: spec.id, packageId: spec.packageId, attachments, changes: { list: changes, scripts } })
    return {
      valid: true,
      proposalId,
      iflowId: spec.id,
      status: 'PENDING',
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
  // the format is our own, bounded text: cut off, the model would get broken JSON
  if (json.length > MAX_RESULT_CHARS && name !== 'getSupportedSteps') json = json.slice(0, MAX_RESULT_CHARS) + '… [truncated]'
  return json
}

module.exports = { definitions, execute, nameSession, normalizeSpecArgs, TOPICS }
