/**
 * iFlow spec v1 validator: JSON Schema + semantic rules.
 * Returns human-readable errors an LLM (or a user) can act on directly, and the same
 * errors as issues with a stable code ({ code, message }) for compact tool results.
 */
const Ajv = require('ajv')
const schema = require('./spec-schema.json')
const { AUTH_TYPES, PROXY_TYPES, checkAgainstReferences } = require('./receiver-settings')
const cpiValues = require('./cpi-values')
const specSteps = require('./spec-steps')
const placeholders = require('./placeholders')

const ajv = new Ajv({ allErrors: true, strict: false })
const checkSchema = ajv.compile(schema)

const SUPPORTED_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson', 'requestReplyHttp', 'requestReplySoap', 'sendMail', 'writeVariables', 'router', 'splitter', 'gather', 'processCall', 'messageMapping', 'xsltMapping', 'multicast']
// steps with a receiver of their own (a participant and an adapter)
const RECEIVER_STEPS = ['requestReplyHttp', 'requestReplySoap', 'sendMail']
// not inside routes, the exception subprocess or local processes
const MAIN_LINE_ONLY = ['router', 'splitter', 'gather', 'multicast']
// Steps allowed in the exception subprocess (of the receivers only a Send step: no reply to wait for; Write Variables
// only in the main flow so far)
const SUPPORTED_EXCEPTION_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson', 'processCall', 'sendMail', 'messageMapping', 'xsltMapping']
// Steps allowed in a local process (a router on its line, as on the main line; no splitters or process calls so far)
const SUPPORTED_LOCAL_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson', 'requestReplyHttp', 'requestReplySoap', 'sendMail', 'messageMapping', 'xsltMapping', 'writeVariables', 'router']
const SUPPORTED_TRIGGERS = ['httpsSender', 'soapSender', 'processDirectSender', 'timer']
const MAX_MAIN_STEPS = 50 // per process: the main flow and each local process, with its routers and the steps inside routes
const SUPPORTED_ENDS = ['httpReceiver', 'none']

// Step kinds people (and LLMs) ask for that v1 deliberately does not build
const NOT_IN_V1 = /gateway|aggregat|filter/i
// Error handling is supported, but as the top-level exceptionSubprocess field, not as a step
const EXCEPTION_STEP = /exception|error|subprocess|catch/i
// Start and end events are not steps: the trigger and the end are top-level fields
const END_STEP = /^(none|end|endEvent|messageEnd|httpReceiver)$/i
const TRIGGER_STEP = /^(start|startEvent|timer|httpsSender|soapSender|processDirectSender|sender)$/i

const DEFAULT_STEP_NAMES = {
  contentModifier: 'Content Modifier',
  groovyScript: 'Groovy Script',
  jsonToXml: 'JSON to XML Converter',
  xmlToJson: 'XML to JSON Converter',
  requestReplyHttp: 'Request Reply',
  writeVariables: 'Write Variables',
  iteratingSplitter: 'Iterating Splitter',
  generalSplitter: 'General Splitter',
  gather: 'Gather',
  processCall: 'Process Call',
  loopingProcessCall: 'Looping Process Call',
  sendMail: 'Send',
  messageMapping: 'Message Mapping',
  xsltMapping: 'XSLT Mapping',
  parallelMulticast: 'Parallel Multicast',
  sequentialMulticast: 'Sequential Multicast'
}
/** The key of a step's default name: splitters by kind, a process call with a loop is a Looping Process Call, any Request Reply counts as one */
const defaultKey = (s) =>
  s.type === 'multicast' ? `${s.mode === 'sequential' ? 'sequential' : 'parallel'}Multicast` : s.type === 'splitter' ? `${s.kind === 'general' ? 'general' : 'iterating'}Splitter` : s.type === 'processCall' && s.loop ? 'loopingProcessCall' : s.type === 'requestReplySoap' ? 'requestReplyHttp' : s.type
const DEFAULT_EXCEPTION_SUBPROCESS_NAME = 'Exception Subprocess 1'

const GROOVY_IMPORT = /import\s+com\.sap\.gateway\.ip\.core\.customdev\.util\.Message\s*;?/
const GROOVY_ENTRY = /def\s+Message\s+processData\s*\(\s*Message\s+message\s*\)/
const PARAM_REF = /\{\{\s*([^}]*?)\s*\}\}/g
const WHOLE_PARAM = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/
// receiver credentials are names of deployed security material, never secrets
const CREDENTIAL_HINT = 'give the name of the security material deployed in CPI (User Credentials or OAuth2 Client Credentials), never a password or secret'

const SECRET_NAME = /pass(word|wd)?|pwd|secret|api[-_]?key|token|authorization|client[-_]?secret/i
/** A Groovy script with a hard-coded password, token or Basic credentials (inline code and writeScript) */
const hasScriptSecret = (code) => /(password|passwd|pwd|secret|token)\w*\s*=\s*["'][^"'$]{3,}["']/i.test(code) || /Basic\s+[A-Za-z0-9+/]{12,}={0,2}/.test(code)

/** Steps of the exception subprocess, [] without one */
const exceptionSteps = (spec) => (Array.isArray(spec?.exceptionSubprocess?.steps) ? spec.exceptionSubprocess.steps : [])

/** Display names and receiver system names as the builder will use them */
function effectiveNames(spec) {
  const counters = {}
  const main = spec.steps || []
  const sub = exceptionSteps(spec)
  const isStep = (x) => x.step && typeof x.step === 'object'
  const flatMain = specSteps.mainSteps(spec).filter(isStep) // main flow with the steps inside routes
  const flatLocal = specSteps.localSteps(spec).filter(isStep)
  const multicasts = flatMain.map((x) => x.step).filter((s) => s.type === 'multicast')
  const explicit = new Set([...flatMain.map((x) => x.step), ...sub, ...flatLocal.map((x) => x.step)].map((s) => s?.name).concat(multicasts.map((s) => s.join)).filter(Boolean))
  // Defaults count per type across the main flow, the exception subprocess and the local processes
  // ("Content Modifier 1", "… 2") and skip names given explicitly
  const name = (s) => {
    if (s.name) return s.name
    const key = defaultKey(s)
    let n
    do n = `${DEFAULT_STEP_NAMES[key] || s.type} ${(counters[key] = (counters[key] || 0) + 1)}`
    while (explicit.has(n))
    return n
  }
  // names in flow order (a router's route steps right after it), so defaults count as the flow reads
  const named = new Map(flatMain.map((x) => [x.step, name(x.step)]))
  // the Join a multicast's branches meet at: Join 1, Join 2, ...
  const joins = new Map(multicasts.map((s) => [s, s.join || name({ type: 'Join' })]))
  const steps = main.map((s) => named.get(s))
  const exception = sub.map(name)
  for (const x of flatLocal) named.set(x.step, name(x.step))
  let rr = 0
  const systemOf = new Map([...flatMain.map((x) => x.step), ...sub, ...flatLocal.map((x) => x.step)].map((s) => [s, RECEIVER_STEPS.includes(s?.type) ? s.system || `Receiver${++rr}` : null]))
  const systems = main.map((s) => systemOf.get(s))
  const exceptionSystems = sub.map((s) => systemOf.get(s))
  // every main-flow step with its path, name and receiver: [{ step, where, name, system }]; local: the same for local processes
  const withNames = (x) => ({ ...x, name: named.get(x.step), system: systemOf.get(x.step) })
  const flat = flatMain.map(withNames)
  const local = flatLocal.map(withNames)
  const endSystem = spec.end?.type === 'httpReceiver' ? spec.end.system || 'Receiver' : null
  const exceptionSubprocess = spec.exceptionSubprocess ? spec.exceptionSubprocess.name || DEFAULT_EXCEPTION_SUBPROCESS_NAME : null
  return { steps, systems, flat, local, joins, endSystem, exceptionSubprocess, exceptionSteps: exception, exceptionSystems }
}

/**
 * A relative XPath: CPI evaluates it from the document root, so 'order/id' works when the root element is <order>,
 * but 'id' finds nothing. A note, since the root element is not known here. Functions like count(//order) are fine.
 */
const relativeXPath = (v) => typeof v === 'string' && v.trim() !== '' && !/^\s*(\/|\(|[A-Za-z][\w.-]*(:[\w-]+)?\s*\()/.test(v)
const xpathNote = (where, v) => {
  const path = v.trim().replace(/^\.\/?/, '')
  return `${where}: the XPath '${v}' is relative; CPI evaluates it from the document root, so it only works if it starts with the root element (e.g. 'order/${path}'). Safer: start it with / or //, e.g. '/order/${path}'`
}

/**
 * What is wrong with a condition, or null: NonXML reads ${...} and has spaces around the operator
 * (${property.x} = 'A', not ${property.x}='A'); XML is an XPath without ${...}
 */
function conditionProblem(c, expressionType) {
  if (expressionType === 'NonXML') {
    if (!c.includes('${')) return `a NonXML condition reads a header or property with \${...}, e.g. "\${property.routeKey} = 'A'"`
    if (/\S(=|!=|<=|>=|<|>|=~)\S/.test(c.replace(/\$\{[^}]*\}/g, (m) => m.replace(/[=<>!~]/g, '_')).replace(/'[^']*'/g, "''")))
      return `put spaces around the operator, e.g. "\${property.x} = 'A'", not "\${property.x}='A'"`
  }
  if (expressionType === 'XML' && c.includes('${')) return `an XML condition is an XPath, e.g. "/root/type = 'X'"; for \${...} set expressionType "NonXML"`
  return null
}

const label = (path) =>
  path
    .replace(/^\//, '')
    .split('/')
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), '') || 'spec'

const PATTERN_HINTS = {
  id: 'use letters, digits and underscore only, e.g. Order_Forward',
  packageId: 'use letters, digits and dots only (CPI package ids cannot contain underscores)',
  fileName: 'use a name without extension, starting with a letter, e.g. setHeaders',
  url: 'use a full http(s) URL or a whole parameter reference like {{TargetURL}}',
  address: 'use a path like /orders/create (letters, digits, - _ . ~)',
  system: 'use letters, digits and underscore only',
  name: 'use letters, digits, dot, dash or underscore',
  credentialName: 'use the name of the deployed credential (letters, digits, dot, dash, underscore) or a whole parameter like {{ErpCredential}}',
  locationId: 'use letters, digits, dot, dash or underscore, or a whole parameter like {{ErpLocation}}',
  server: 'use host:port, e.g. smtp.example.com:587, or a whole parameter like {{Mail_Server}}',
  from: 'use one mail address, e.g. noreply@example.com',
  to: 'use mail addresses separated by commas, or a whole parameter like {{Mail_To}}',
  cc: 'use mail addresses separated by commas',
  bcc: 'use mail addresses separated by commas'
}

/** Translates Ajv errors into plain sentences: [{ code, message }] */
function schemaErrors(errors, skipPaths) {
  const out = []
  const push = (code, message) => out.push({ code, message })
  for (const e of errors) {
    if (e.keyword === 'if') continue // the specific error of the "then" branch is reported separately
    if (skipPaths.some((p) => e.instancePath === p || e.instancePath.startsWith(p + '/'))) continue
    // credential fields on a receiver: reported with CREDENTIAL_HINT by the receiver rules
    const field_ = e.params?.additionalProperty
    if (e.keyword === 'additionalProperties' && /^\/(steps\/\d+|end)$/.test(e.instancePath) && (/^(credentialAlias|user(name)?|clientId)$/i.test(field_) || SECRET_NAME.test(field_))) continue
    const where = label(e.instancePath)
    const field = e.instancePath.split('/').pop()
    switch (e.keyword) {
      case 'required':
        // no default on purpose: whether one failing item stops the others is the user's decision
        if (e.params.missingProperty === 'stopOnException')
          push('MISSING_FIELD', `${where}: missing required field 'stopOnException' — true: one failing item stops the rest; false: the other items still run. Ask the user if the request does not say`)
        else push('MISSING_FIELD', `${where}: missing required field '${e.params.missingProperty}'`)
        break
      case 'additionalProperties':
        push('UNKNOWN_FIELD', `${where}: unknown field '${e.params.additionalProperty}'`)
        break
      case 'enum':
        push('BAD_VALUE', `${where}: must be one of ${e.params.allowedValues.join(', ')}`)
        break
      case 'const':
        push('BAD_VALUE', `${where}: must be '${e.params.allowedValue}'`)
        break
      case 'pattern':
        push('BAD_FORMAT', `${where}: invalid value — ${PATTERN_HINTS[field] || `must match ${e.params.pattern}`}`)
        break
      case 'propertyNames':
        push('BAD_PARAM_NAME', `${where}: invalid parameter name '${e.params.propertyName}' — start with a letter, then letters, digits or underscore`)
        break
      default:
        push(e.keyword === 'maxItems' ? 'TOO_MANY' : e.keyword === 'type' ? 'BAD_TYPE' : 'INVALID', `${where}: ${e.message}`)
    }
  }
  return out
}

/** Visits every string in the spec with its path */
function walkStrings(node, path, fn) {
  if (typeof node === 'string') return fn(node, path)
  if (Array.isArray(node)) return node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, fn))
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walkStrings(v, path ? `${path}.${k}` : k, fn)
}

/**
 * Fields where {{Parameter}} references are allowed: an HTTP receiver's URL, credential name and location ID,
 * and the value of a constant header or property (an externalized value; the other sources name a header,
 * property, variable or XPath)
 */
const STEP_PATH = String.raw`(steps\[\d+\](\.branches\[\d+\]\.steps\[\d+\])?(\.routes\[\d+\]\.steps\[\d+\])?|exceptionSubprocess\.steps\[\d+\]|localProcesses\[\d+\]\.steps\[\d+\](\.routes\[\d+\]\.steps\[\d+\])?)`
const PARAM_FIELDS = new RegExp(String.raw`^((${STEP_PATH}|end)\.(url|credentialName|locationId|server|to)|${STEP_PATH}\.(headers|properties)\[\d+\]\.value)$`)

/**
 * @param {object} spec
 * @param {{ attachments?: string[] }} [options] - file names (with extension) attached in the
 *   conversation; a groovyScript without code uses <fileName>.groovy, resources name .xsl files
 * @returns {{ valid: boolean, errors: string[], issues: { code: string, message: string }[] }}
 */
function validate(spec, { attachments = [] } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    return { valid: false, errors: ['spec: must be a JSON object'], issues: [{ code: 'NOT_OBJECT', message: 'spec: must be a JSON object' }] }
  const issues = []
  const err = (code, message) => issues.push({ code, message })
  const skip = []

  // Unsupported step/trigger/end types get one clear message instead of schema noise
  const supportedList = SUPPORTED_STEPS.join(', ')
  for (const { step: s, where, ptr, route, branch } of specSteps.mainSteps(spec)) {
    const type = s?.type
    if (route && type === 'router') {
      skip.push(ptr)
      err('NESTED_ROUTER', `${where}: a router inside a route is not supported — routers sit on the main line or a multicast branch; put the routing there, or decide it in a groovyScript that sets a property for the next router`)
      continue
    }
    if (route && MAIN_LINE_ONLY.includes(type)) {
      skip.push(ptr)
      err('MAIN_LINE_ONLY', `${where}: a ${type} inside a route is not supported — splitters and gathers sit on the main line or a multicast branch, multicasts on the main line`)
      continue
    }
    if (branch && type === 'multicast') {
      skip.push(ptr)
      err('NESTED_MULTICAST', `${where}: a multicast inside a branch is not supported — multicasts sit on the main line; call a local process, or run them one after the other`)
      continue
    }
    if (!type || SUPPORTED_STEPS.includes(type)) continue
    skip.push(ptr)
    if (/router|gateway/i.test(type))
      err('USE_ROUTER', `${where}: '${type}' — a router is { "type": "router", "expressionType": "XML"|"NonXML", "routes": [{ "name", "condition", "steps"?, "end"? }, ..., { "name", "default": true }] }`)
    else if (/split/i.test(type))
      err('USE_SPLITTER', `${where}: '${type}' — a splitter is { "type": "splitter", "kind": "iterating"|"general", "expression": "//item", "stopOnException": true|false }; the steps after it run per item until a { "type": "gather", "source", "target" }`)
    else if (/xsl/i.test(type)) err('USE_MAPPING', `${where}: '${type}' — an XSLT step is { "type": "xsltMapping", "file": "transform.xsl" }, with the file attached`)
    else if (/mapping/i.test(type)) err('USE_MAPPING', `${where}: '${type}' — a Message Mapping is { "type": "messageMapping", "mapping": "<artifact id>" }`)
    else if (/soap/i.test(type)) err('USE_SOAP', `${where}: '${type}' — a SOAP call is { "type": "requestReplySoap", "url", "authType": "Basic", "credentialName", "proxyType": "On-Premise", "locationId"? }`)
    else if (/mail|smtp/i.test(type)) err('USE_MAIL', `${where}: '${type}' — a mail is { "type": "sendMail", "server": "host:port", "credentialName", "from", "to", "subject", "body"? }`)
    else if (/multicast|join|sequential|parallel/i.test(type))
      err('USE_MULTICAST', `${where}: '${type}' — a multicast is { "type": "multicast", "mode": "parallel"|"sequential", "join"?, "branches": [{ "name"?, "steps": [...] }, ...] }, and the next step is a { "type": "gather" }; the builder adds the Join`)
    else if (/gather/i.test(type)) err('USE_GATHER', `${where}: '${type}' — a gather is { "type": "gather" } (Combine), or with "source" and "target" (Combine at XPath), after a splitter`)
    else if (END_STEP.test(type))
      err('END_AS_STEP', `${where}: '${type}' is the end of the flow, not a step — remove it from steps; the end is the top-level 'end' (or a route's 'end'), e.g. { "type": "none" }`)
    else if (TRIGGER_STEP.test(type))
      err('TRIGGER_AS_STEP', `${where}: '${type}' is the trigger, not a step — remove it from steps; the trigger is the top-level 'trigger', e.g. { "type": "timer", "mode": "once" }`)
    else if (EXCEPTION_STEP.test(type))
      err('EXCEPTION_AS_STEP', `${where}: error handling is not a step — remove '${type}' from steps and put the error handling steps into the top-level 'exceptionSubprocess': { "steps": [...] }`)
    // after the error handling check: "exceptionSubprocess" contains "process"
    else if (/process|loop/i.test(type))
      err('USE_PROCESS_CALL', `${where}: '${type}' — a process call is { "type": "processCall", "process": "<local process name>", "loop"?: { "condition", "max" } }, with the process in the top-level localProcesses`)
    else if (NOT_IN_V1.test(type))
      err(
        'STEP_NOT_IN_V1',
        `${where}: '${type}' is not supported yet. Supported step types: ${supportedList}.`
      )
    else err('UNKNOWN_STEP', `${where}: unknown step type '${type}'. Supported step types: ${supportedList}.`)
  }
  const exceptionList = SUPPORTED_EXCEPTION_STEPS.join(', ')
  exceptionSteps(spec).forEach((s, i) => {
    const type = s?.type
    if (!type || SUPPORTED_EXCEPTION_STEPS.includes(type)) return
    skip.push(`/exceptionSubprocess/steps/${i}`)
    err(
      'EXCEPTION_STEP_UNSUPPORTED',
      type === 'requestReplyHttp'
        ? `exceptionSubprocess.steps[${i}]: requestReplyHttp is not supported in the exception subprocess in v1. Supported: ${exceptionList}. The subprocess result is returned to the sender.`
        : `exceptionSubprocess.steps[${i}]: '${type}' is not supported in the exception subprocess. Supported: ${exceptionList}.`
    )
  })
  const localList = SUPPORTED_LOCAL_STEPS.join(', ')
  for (const { step: s, where, ptr, route } of specSteps.localSteps(spec)) {
    const type = s?.type
    if (route && type === 'router') {
      skip.push(ptr)
      err('NESTED_ROUTER', `${where}: a router inside a route is not supported — in a local process too, routers sit on its line only`)
      continue
    }
    if (!type || SUPPORTED_LOCAL_STEPS.includes(type)) continue
    skip.push(ptr)
    err(
      'LOCAL_STEP_UNSUPPORTED',
      SUPPORTED_STEPS.includes(type)
        ? `${where}: a ${type} inside a local process is not supported yet (no splitters, gathers or process calls there). Supported: ${localList}.`
        : `${where}: '${type}' is not supported in a local process. Supported: ${localList}.`
    )
  }
  if (spec.trigger?.type && !SUPPORTED_TRIGGERS.includes(spec.trigger.type)) {
    skip.push('/trigger')
    err('TRIGGER_UNSUPPORTED', `trigger: '${spec.trigger.type}' is not supported yet. Use httpsSender { address }, soapSender { address }, processDirectSender { address }, timer { mode: "once" } or timer { mode: "every", minutes }.`)
  }
  if (spec.end?.type && !SUPPORTED_ENDS.includes(spec.end.type)) {
    skip.push('/end')
    err('END_UNSUPPORTED', `end: '${spec.end.type}' is not supported in v1. Use httpReceiver { url, method, authType } or none.`)
  }

  // Receiver authentication, proxy and timeout: one actionable message per problem instead of schema noise
  const calls = [...specSteps.mainSteps(spec), ...specSteps.localSteps(spec)]
    .filter((x) => x.step?.type === 'requestReplyHttp')
    .map((x) => [x.step, x.where, x.ptr])
  if (spec.end?.type === 'httpReceiver') calls.push([spec.end, 'end', '/end'])
  const referenceWarnings = []
  const valueCheck = (component, stored, where) => {
    const r = cpiValues.checkValues(component, stored, where)
    r.errors.forEach((m) => err('NOT_IN_REFERENCES', m))
    referenceWarnings.push(...r.warnings)
  }
  for (const [call, where, ptr] of calls) {
    const auth = call.authType ?? 'None'
    if (AUTH_TYPES.includes(auth)) {
      if (auth !== 'None' && !call.credentialName && !('credentialAlias' in call)) err('CREDENTIAL_MISSING', `${where}.credentialName: required with authType ${auth} — ${CREDENTIAL_HINT}`)
      if (auth === 'None' && call.credentialName) err('CREDENTIAL_UNUSED', `${where}.credentialName: only used with authType Basic or OAuth2 Client Credentials — remove it, or set authType`)
    }
    if ('credentialAlias' in call) err('UNKNOWN_FIELD', `${where}: unknown field 'credentialAlias' — use credentialName (${CREDENTIAL_HINT})`)
    for (const key of Object.keys(call).filter((k) => SECRET_NAME.test(k) || /^(user(name)?|clientId)$/i.test(k))) {
      skip.push(`${ptr}/${key}`)
      err('SECRET', `${where}.${key}: never put credentials into the spec — ${CREDENTIAL_HINT}`)
    }
    // a {{Parameter}} is checked by the parameter rules below, not by the name pattern of the schema
    for (const key of ['credentialName', 'locationId'].filter((k) => typeof call[k] === 'string' && call[k].includes('{{'))) skip.push(`${ptr}/${key}`)
    if (call.locationId && call.proxyType !== 'On-Premise') err('LOCATION_WITHOUT_PROXY', `${where}.locationId: only used with proxyType On-Premise — remove it, or set proxyType "On-Premise"`)
    // the stored values must be ones the reference exports contain (a value seen once is a warning)
    if (AUTH_TYPES.includes(auth) && (call.proxyType == null || call.proxyType in PROXY_TYPES)) {
      const r = checkAgainstReferences(call, where)
      r.errors.forEach((m) => err('NOT_IN_REFERENCES', m))
      referenceWarnings.push(...r.warnings)
    }
  }

  // SOAP and Mail receivers: credentials never in the spec; on SOAP only the url can be a parameter (the references
  // have no parameter reference for its credential name and location ID); stored values from the references
  for (const { step: s, where, ptr } of [...specSteps.allSteps(spec)].filter((x) => ['requestReplySoap', 'sendMail'].includes(x.step?.type))) {
    for (const key of Object.keys(s).filter((k) => SECRET_NAME.test(k) || /^(user(name)?|clientId)$/i.test(k))) {
      skip.push(`${ptr}/${key}`)
      err('SECRET', `${where}.${key}: never put credentials into the spec — ${CREDENTIAL_HINT}`)
    }
    if (s.type === 'requestReplySoap') {
      for (const key of ['credentialName', 'locationId'].filter((k) => typeof s[k] === 'string' && s[k].includes('{{'))) {
        skip.push(`${ptr}/${key}`)
        err('PARAM_NOT_URL', `${where}.${key}: on a SOAP receiver only the url can be a parameter — give the name itself`)
      }
      if (typeof s.url === 'string' && /^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(s.url)) err('URL_CREDENTIALS', `${where}.url: contains user:password — remove it; set credentialName instead (${CREDENTIAL_HINT})`)
      if (s.authType === 'Basic' && s.proxyType === 'On-Premise') valueCheck('SOAP Receiver', [['authentication', 'Basic'], ['proxyType', 'sapcc']], where)
    } else {
      if (typeof s.body === 'string' && /"(password|passwd|pwd|secret|client_secret|token)"\s*:\s*"[^"$]+"/i.test(s.body)) err('SECRET', `${where}.body: contains a plaintext secret — never put passwords or tokens in the flow`)
      valueCheck('Mail Receiver', [['auth', 'loginPlain'], ['ssl', 'starttls_mandatory'], ['content_type', 'text/plain']], where)
    }
  }

  if (!checkSchema(spec)) issues.push(...schemaErrors(checkSchema.errors, skip))

  // --- semantic rules (defensive: the spec may be partially invalid) ------------
  const isObj = (s) => s && typeof s === 'object'
  const steps = Array.isArray(spec.steps) ? spec.steps : []
  const subSteps = exceptionSteps(spec)
  const locals = specSteps.localProcesses(spec).filter(isObj)
  const names = effectiveNames({
    ...spec,
    steps: steps.filter(isObj),
    ...(isObj(spec.exceptionSubprocess) && { exceptionSubprocess: { ...spec.exceptionSubprocess, steps: subSteps.filter(isObj) } }),
    localProcesses: locals.map((p) => ({ ...p, steps: (Array.isArray(p.steps) ? p.steps : []).filter(isObj) }))
  })
  // [step, path] of the main flow (with the steps inside routes), the exception subprocess and the local processes
  const allSteps = specSteps.allSteps(spec).map((x) => [x.step, x.where])

  const dupes = (list) => [...new Set(list.filter((v, i) => v && list.indexOf(v) !== i))]
  // where a duplicate is, and what to do: the model cannot fix "used more than once" without the positions
  const namedAt = [
    ...names.flat.map((x) => [x.name, x.where, x.step]),
    ...names.exceptionSteps.map((n, i) => [n, `exceptionSubprocess.steps[${i}]`, subSteps[i]]),
    ...names.local.map((x) => [x.name, x.where, x.step]),
    ...[...names.joins.values()].map((n) => [n, 'a multicast join', null]),
    [names.exceptionSubprocess, 'exceptionSubprocess.name', null]
  ]
  const fix = (hits) => {
    const same = hits.length > 1 && hits.every(([, , st]) => st && JSON.stringify(st) === JSON.stringify(hits[0][2]))
    const last = hits.at(-1)[1]
    const remove = (path) => {
      const m = path.match(/^(exceptionSubprocess\.)?steps\[(\d+)\]$/) // route steps: no editDraftSpec op, "remove <path>"
      return m ? `editDraftSpec {"op":"removeStep","index":${m[2]}${m[1] ? ',"exception":true' : ''}}` : `remove ${path}`
    }
    return same ? `the same step was added twice: remove ${last} (${remove(last)})` : `rename all but one, or remove the extra step (${remove(last)})`
  }
  for (const d of dupes([...names.flat.map((x) => x.name), ...names.exceptionSteps, ...names.local.map((x) => x.name), ...names.joins.values(), names.exceptionSubprocess])) {
    const hits = namedAt.filter(([n]) => n === d)
    err(
      'DUPLICATE_STEP_NAME',
      `steps: step name '${d}' is used more than once, at ${hits.map(([, p]) => p).join(' and ')} — step names must be unique (main flow, routes, exception subprocess and local processes together); ${fix(hits)}`
    )
  }
  for (const d of dupes(locals.map((p) => p.name))) err('DUPLICATE_PROCESS_NAME', `localProcesses: local process name '${d}' is used more than once — give each local process its own name`)
  for (const d of dupes([...names.flat.map((x) => x.system), ...names.exceptionSystems, ...names.local.map((x) => x.system), names.endSystem]))
    err('DUPLICATE_SYSTEM', `receiver system name '${d}' is used more than once — give each receiver a unique 'system'`)
  for (const d of dupes(allSteps.filter(([s]) => s?.type === 'groovyScript').map(([s]) => s.fileName))) {
    const hits = allSteps.filter(([s]) => s?.type === 'groovyScript' && s.fileName === d).map(([st, p]) => [d, p, st])
    err('DUPLICATE_FILENAME', `steps: Groovy fileName '${d}' is used more than once, at ${hits.map(([, p]) => p).join(' and ')} — each script needs its own file; ${fix(hits)}`)
  }

  // --- end events: an escalation category only on an Escalation End, and one the references contain ---
  const routeEnds = (list, prefix) =>
    list.flatMap((r, i) => (r?.type === 'router' && Array.isArray(r.routes) ? r.routes.map((x, j) => [`${prefix}[${i}].routes[${j}].end`, x?.end]) : []))
  // the steps of the multicast branches on the main line: [list, its path]
  const branchLines = steps.flatMap((m, i) => (m?.type === 'multicast' && Array.isArray(m.branches) ? m.branches.filter(isObj).map((b, j) => [Array.isArray(b.steps) ? b.steps.filter(isObj) : [], `steps[${i}].branches[${j}].steps`]) : []))
  const ends = [['end', spec.end], ['exceptionSubprocess.end', spec.exceptionSubprocess?.end], ...routeEnds(steps, 'steps'), ...branchLines.flatMap(([list, prefix]) => routeEnds(list, prefix))].filter(([, e]) => isObj(e))
  // a route in a local process ends with the plain End of a local process (the only end event the references have there)
  locals.forEach((p, i) => {
    for (const [where, e] of routeEnds(Array.isArray(p.steps) ? p.steps : [], `localProcesses[${i}].steps`).filter(([, e]) => isObj(e)))
      if ((e.event && e.event !== 'message') || e.category != null)
        err('LOCAL_END_EVENT', `${where}: a route in a local process ends with a plain End ({ "event": "message" }) — Escalation and Error Ends in local processes are not supported yet`)
  })
  for (const [where, e] of ends) {
    if (e.category != null && e.event !== 'escalation') err('CATEGORY_WITHOUT_ESCALATION', `${where}.category: only an Escalation End has a category — remove it, or set "event": "escalation"`)
    else if (e.event === 'escalation' && (e.category == null || schema.definitions.endEvent.properties.category.enum.includes(e.category)))
      valueCheck('Escalation End', [['category', e.category || cpiValues.DEFAULT_ESCALATION_CATEGORY]], where) // other values: the schema says which
  }

  // --- routers, ends, size ------------------------------------------------------------
  // The limit is per process: the main flow and each local process count their steps, routers and the steps inside
  // routes (route ends do not count); the exception subprocess has its own limit in the schema
  const tooMany = (where, count) => `${where}: ${count} steps with the routers and the steps inside routes — at most ${MAX_MAIN_STEPS} per process; merge Content Modifiers or move logic into one Groovy script`
  if (names.flat.length > MAX_MAIN_STEPS && steps.length <= MAX_MAIN_STEPS) err('TOO_MANY_STEPS', tooMany('steps', names.flat.length))
  locals.forEach((p, i) => {
    const list = Array.isArray(p.steps) ? p.steps : []
    const count = specSteps.lineSteps(list, '').length
    if (count > MAX_MAIN_STEPS && list.length <= MAX_MAIN_STEPS) err('TOO_MANY_STEPS', tooMany(`localProcesses[${i}] '${p.name}'`, count))
  })
  /** The router rules for one line: the main line, a multicast branch, or a local process (the last two have no end of their own to set) */
  const checkRouters = (list, prefix, isMain) =>
    list.forEach((r, i) => {
      if (r?.type !== 'router' || !Array.isArray(r.routes)) return
      const where = `${prefix}[${i}]`
      const routes = r.routes.filter(isObj)
      if (['XML', 'NonXML'].includes(r.expressionType)) valueCheck('Router', [['expressionType', r.expressionType]], where) // written on every route
      const defaults = routes.filter((x) => x.default === true)
      if (defaults.length !== 1) err('ROUTER_DEFAULT', `${where}.routes: exactly one route needs "default": true (found ${defaults.length}) — the default route takes every message no other condition matches`)
      else if (routes.at(-1) !== defaults[0]) err('ROUTER_DEFAULT_LAST', `${where}.routes: list the default route '${defaults[0].name}' last — CPI evaluates it last`)
      for (const d of dupes(routes.map((x) => x.name))) err('DUPLICATE_ROUTE_NAME', `${where}.routes: route name '${d}' is used more than once — route names must be unique within a router`)
      routes.forEach((route, j) => {
        const at = `${where}.routes[${j}]`
        if (route.default === true && route.condition != null) err('DEFAULT_WITH_CONDITION', `${at}: the default route has no condition — remove 'condition'`)
        if (route.default !== true && !(typeof route.condition === 'string' && route.condition.trim())) err('CONDITION_MISSING', `${at}: a route that is not the default needs a 'condition'`)
        if (typeof route.condition !== 'string' || !route.condition.trim()) return
        const problem = conditionProblem(route.condition, r.expressionType)
        if (problem) err('CONDITION_FORMAT', `${at}.condition: ${problem}`)
      })
      // a router whose routes all end must be the last step, and the main flow has no end of its own
      if (routes.length && routes.every((x) => x.end)) {
        if (i < list.length - 1) err('ROUTER_ALL_END', `${where}: every route ends, so the steps after the router can never run — make the router the last step, or let a route continue (no 'end')`)
        if (isMain && spec.end && (spec.end.type !== 'none' || (spec.end.event && spec.end.event !== 'message')))
          err('ROUTER_ALL_END', `end: every route of the last router ends, so the main flow has no end of its own — set "end": { "type": "none" }`)
      }
    })
  checkRouters(steps, 'steps', true)
  for (const [list, prefix] of branchLines) {
    checkRouters(list, prefix, false)
    const last = list.at(-1)
    if (last?.type === 'router' && Array.isArray(last.routes) && last.routes.length && last.routes.every((x) => x?.end))
      err('BRANCH_MUST_REACH_JOIN', `${prefix}[${list.length - 1}]: every route ends, so this branch never reaches the Join — let a route continue (no 'end')`)
    // the tenant check of phase 9: with two continuing routes CPI marks the Join with "Multicast does not exist for join"
    list.forEach((r, i) => {
      const continuing = r.type === 'router' && Array.isArray(r.routes) ? r.routes.filter((x) => isObj(x) && !x.end) : []
      if (continuing.length > 1)
        err('BRANCH_ROUTES_JOIN', `${prefix}[${i}]: the routes ${continuing.map((x) => `'${x.name}'`).join(', ')} all continue, but CPI does not accept routes that join again inside a multicast branch — let at most one route continue to the Join and give the others an 'end', or, to join routes again, route inside a local process called with a Process Call`)
    })
  }
  locals.forEach((p, i) => checkRouters(Array.isArray(p.steps) ? p.steps : [], `localProcesses[${i}].steps`, false))

  // --- splitters and gathers: a gather closes the split of the splitter before it, or follows a multicast --
  // In a branch: every split closes before the Join (CPI: "always use gather in between splitter - join"), and no
  // router comes before a gather: the tenant check of phase 9 showed CPI refuses it even if only one route reaches it
  const checkSplits = (list, prefix, inBranch) => {
  let split = null // [splitter, path] whose items are still split
  let routersInSplit = [] // paths of the routers since that splitter: CPI refuses a router before its gather
  list.forEach((s, i) => {
    const where = `${prefix}[${i}]`
    if (s?.type === 'router' && (split || inBranch)) routersInSplit.push(where)
    if (s?.type === 'multicast') {
      if (split) err('MULTICAST_IN_SPLIT', `${where}: a multicast between the splitter ${split[1]} and its gather is not supported — add a gather before the multicast, or call a local process per item`)
      const next = list[i + 1]
      if (next?.type !== 'gather') err('JOIN_WITHOUT_GATHER', `${where}: the step after a multicast must be a { "type": "gather" }, which combines the branches after the Join`)
      else if (next.source || next.target) err('JOIN_GATHER_COMBINE', `${prefix}[${i + 1}]: a gather after a multicast's Join is Combine — remove 'source' and 'target'`)
    }
    if (s?.type === 'gather' && list[i - 1]?.type === 'multicast') {
      valueCheck('Gather', [['messageType', 'SameXMLFormat'], ['aggregationAlgorithm', cpiValues.GATHER_COMBINE]], where)
      return
    }
    if (s?.type === 'splitter') {
      if (split) err('NESTED_SPLIT', `${where}: a splitter between the splitter ${split[1]} and its gather is not supported (no nested splits) — add a gather before this splitter, or split once`)
      else split = [s, where]
      if (['iterating', 'general'].includes(s.kind) && typeof s.stopOnException === 'boolean')
        valueCheck('Splitter', [['exprType', 'XPath'], ['streaming', String(s.streaming ?? true)], ['stopOnException', String(s.stopOnException)], ['parallel', 'false']], where)
    }
    if (s?.type === 'gather') {
      if (!split) err('GATHER_WITHOUT_SPLITTER', `${where}: a gather combines split messages — put a splitter before it, or remove the gather`)
      for (const at of routersInSplit)
        err(
          'ROUTER_IN_SPLIT',
          `${at}: CPI does not accept a router between a splitter and its gather (${where}), even if only one route reaches it — route per item inside a local process instead: a processCall here, and a local process that contains the router${inBranch ? '' : ' (a router after a splitter without a gather is fine)'}`
        )
      split = null
      routersInSplit = []
      if (!s.source !== !s.target) err('GATHER_XPATH', `${where}: Combine at XPath needs both source and target — set both, or remove them for Combine`)
      else valueCheck('Gather', [['messageType', 'SameXMLFormat'], ['aggregationAlgorithm', cpiValues.gatherAlgorithm(s)]], where)
    }
  })
  if (inBranch && split) err('SPLIT_WITHOUT_GATHER', `${split[1]}: a split inside a branch must be closed by a gather before the Join — add a { "type": "gather" } to this branch`)
  }
  checkSplits(steps, 'steps', false)
  for (const [list, prefix] of branchLines) checkSplits(list, prefix, true)

  // --- placeholders: CPI shows only the REPLACE_WITH property (the builder writes it from the description) -----
  for (const [s, where] of allSteps) {
    if (!placeholders.isPlaceholder(s) && !placeholders.hasReplaceWith(s)) continue
    if (!placeholders.usable(placeholders.noteOf(s)))
      err('PLACEHOLDER_NOTE', `${where}: the placeholder '${s.name || ''}' says nothing about what to add — start its description with "REPLACE WITH" followed by the step to add in the CPI editor (type, name, settings); the builder writes that text into its REPLACE_WITH property`)
  }

  // --- process calls: a local process that exists; a looping one with a NonXML condition -------------------
  const processNames = new Set(locals.map((p) => p.name))
  const calledNames = new Set()
  for (const [s, where] of allSteps) {
    if (s?.type !== 'processCall') continue
    if (typeof s.process === 'string') {
      calledNames.add(s.process)
      if (!processNames.has(s.process))
        err('PROCESS_UNKNOWN', `${where}.process: no local process '${s.process}' — add it to localProcesses: [{ "name": "${s.process}", "steps": [...] }], or call one of: ${[...processNames].join(', ') || '(none)'}`)
    }
    if (isObj(s.loop) && typeof s.loop.condition === 'string' && s.loop.condition.trim()) {
      const problem = conditionProblem(s.loop.condition, 'NonXML')
      if (problem) err('CONDITION_FORMAT', `${where}.loop.condition: ${problem}`)
      valueCheck('Looping Process Call', [['expressionType', 'Non XML']], where)
    }
  }
  locals.forEach((p, i) => {
    if (typeof p.name === 'string' && !calledNames.has(p.name)) referenceWarnings.push(`localProcesses[${i}]: no processCall calls the local process '${p.name}', so it never runs`)
  })

  // --- attached files: scripts without code, XSLT resources --------------------------
  const attached = new Set(attachments)
  for (const [s, where] of allSteps) {
    if (s?.type !== 'groovyScript' || typeof s.fileName !== 'string') continue
    const file = `${s.fileName}.groovy`
    if (s.code == null && !attached.has(file))
      err('ATTACHMENT_MISSING', `${where}: no code and no attached file '${file}' — give the code, or ask the user to attach ${file}`)
    if (s.code != null && attached.has(file))
      err('ATTACHED_CODE', `${where}.code: '${file}' is a file of this conversation — omit code to use it (change it with writeScript, or choose another fileName)`)
  }
  // mapping steps: an artifact or a file; files must be of this conversation (the assistant never writes them)
  for (const [s, where] of allSteps) {
    if (s?.type === 'messageMapping') {
      if (!s.mapping === !s.file) err('MAPPING_SOURCE', `${where}: a Message Mapping needs either 'mapping' (an artifact id) or 'file' (a .mmap file of this conversation), not ${s.mapping ? 'both' : 'neither'}`)
      if (s.mapping && s.schemas) err('MAPPING_SOURCE', `${where}.schemas: only with 'file' — an artifact has its own schemas`)
      if (s.mapping) valueCheck('Message Mapping', [['mappingReference', 'static']], where)
      if (typeof s.file === 'string' && !attached.has(s.file)) err('ATTACHMENT_MISSING', `${where}.file: '${s.file}' is not a file of this conversation — a mapping inside the iFlow comes from an imported or existing iFlow and is never written; refer to an artifact with 'mapping', or use a placeholder`)
      for (const f of s.file && Array.isArray(s.schemas) ? s.schemas : []) if (typeof f === 'string' && !attached.has(f)) err('ATTACHMENT_MISSING', `${where}.schemas: '${f}' is not a file of this conversation`)
    }
    if (s?.type === 'xsltMapping') {
      if (typeof s.file === 'string' && !attached.has(s.file)) err('ATTACHMENT_MISSING', `${where}.file: '${s.file}' is not an attached file — ask the user to attach it`)
      valueCheck('XSLT Mapping', [['mappingSource', 'mappingSrcIflow'], ['mappingoutputformat', 'Bytes']], where)
    }
  }
  ;(Array.isArray(spec.resources) ? spec.resources : []).forEach((r, i) => {
    if (typeof r === 'string' && !attached.has(r)) err('ATTACHMENT_MISSING', `resources[${i}]: '${r}' is not an attached file — ask the user to attach it`)
  })

  for (const [s, where] of allSteps) {
    if (s?.type === 'groovyScript' && typeof s.code === 'string') {
      if (!GROOVY_IMPORT.test(s.code))
        err('GROOVY_IMPORT', `${where}.code: Groovy script must import com.sap.gateway.ip.core.customdev.util.Message`)
      if (!GROOVY_ENTRY.test(s.code))
        err('GROOVY_ENTRY', `${where}.code: Groovy script must define 'def Message processData(Message message)' and return the message`)
    }
  }

  const httpCalls = calls.map(([call, where]) => [call, where])
  // Timer: "every" needs its interval; values of timers, Content Modifier sources and Write Variables must be
  // in the reference exports (a value seen once and not confirmed is a warning)
  if (spec.trigger?.type === 'timer') {
    if (spec.trigger.mode === 'every' && spec.trigger.minutes == null) err('MISSING_FIELD', 'trigger: missing required field \'minutes\' (the interval of mode every)')
    if (spec.trigger.mode === 'once' && spec.trigger.minutes != null) err('UNKNOWN_FIELD', 'trigger.minutes: only used with mode every — remove it, or set mode "every"')
    if (['once', 'every'].includes(spec.trigger.mode) && (spec.trigger.mode === 'once' || Number.isInteger(spec.trigger.minutes))) valueCheck('Timer', cpiValues.timerValues(spec.trigger), 'trigger')
  }
  for (const [s, where] of allSteps.filter(([x]) => isObj(x))) {
    if (s.type === 'contentModifier')
      for (const [table, rows] of [['headers', s.headers], ['properties', s.properties]])
        (Array.isArray(rows) ? rows : []).forEach((r, i) => {
          const type = cpiValues.CM_SOURCE_TYPES[r?.type]
          if (!type) return // reported by the schema
          const datatype = r.datatype || (r.type === 'xpath' ? cpiValues.DEFAULT_XPATH_DATATYPE : '')
          valueCheck('Content Modifier', [['sourceType', type], ...(datatype ? [['datatype', datatype]] : [])], `${where}.${table}[${i}]`)
        })
    if (s.type === 'writeVariables')
      (Array.isArray(s.variables) ? s.variables : []).forEach((v, i) => {
        if (!cpiValues.WV_TYPES.includes(v?.type)) return // reported by the schema
        const datatype = v.datatype || (v.type === 'xpath' ? cpiValues.DEFAULT_XPATH_DATATYPE : '')
        valueCheck('Write Variables', [['type', v.type], ['scope', cpiValues.scopeOf(v)], ...(datatype ? [['datatype', datatype]] : [])], `${where}.variables[${i}]`)
      })
  }
  // XPaths that do not start at the document root (Content Modifier and Write Variables rows, splitters, gathers)
  for (const [s, where] of allSteps.filter(([x]) => isObj(x))) {
    if (s.type === 'contentModifier')
      for (const table of ['headers', 'properties'])
        (Array.isArray(s[table]) ? s[table] : []).forEach((r, i) => r?.type === 'xpath' && relativeXPath(r.value) && referenceWarnings.push(xpathNote(`${where}.${table}[${i}].value`, r.value)))
    if (s.type === 'writeVariables')
      (Array.isArray(s.variables) ? s.variables : []).forEach((v, i) => v?.type === 'xpath' && relativeXPath(v.value) && referenceWarnings.push(xpathNote(`${where}.variables[${i}].value`, v.value)))
    if (s.type === 'splitter' && relativeXPath(s.expression)) referenceWarnings.push(xpathNote(`${where}.expression`, s.expression))
    if (s.type === 'gather') for (const k of ['source', 'target']) if (relativeXPath(s[k])) referenceWarnings.push(xpathNote(`${where}.${k}`, s[k]))
  }
  const warnings = [...new Set(referenceWarnings)]
  for (const [call, where] of httpCalls) {
    if (typeof call.url === 'string' && /^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(call.url))
      err('URL_CREDENTIALS', `${where}.url: contains user:password — remove it; set authType and credentialName instead (${CREDENTIAL_HINT})`)
    // CPI keeps the query in the receiver's Query field; the builder splits it off the address
    const param = typeof call.url === 'string' && call.url.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
    const full = param ? String(spec.parameters?.[param] ?? '') : String(call.url ?? '')
    if (full.includes('?'))
      warnings.push(`${where}.url: the query "${full.slice(full.indexOf('?') + 1)}" is written to the receiver's Query field, not the Address${param ? `; the parameter ${param} holds the URL before '?'` : ''}`)
  }

  // --- no plaintext secrets ------------------------------------------------------------
  for (const [s, where] of allSteps) {
    if (s?.type !== 'contentModifier') continue
    for (const table of ['headers', 'properties'])
      (Array.isArray(s[table]) ? s[table] : []).forEach((e, j) => {
        if (e?.type === 'constant' && SECRET_NAME.test(e.name || '') && e.value)
          err(
            'SECRET',
            `${where}.${table}[${j}]: '${e.name}' looks like a secret with a constant value — never put passwords or tokens in the flow; set authentication on the receiver in the CPI web editor instead`
          )
      })
    if (typeof s.body === 'string' && /"(password|passwd|pwd|secret|client_secret|token)"\s*:\s*"[^"$]+"/i.test(s.body))
      err('SECRET', `${where}.body: contains a plaintext secret — never put passwords or tokens in the flow`)
  }
  for (const [s, where] of allSteps) {
    if (s?.type !== 'groovyScript' || typeof s.code !== 'string') continue
    if (hasScriptSecret(s.code))
      err('SECRET', `${where}.code: contains a hard-coded secret — read credentials from deployed security material (SecureStoreService) instead`)
  }

  // --- characters ------------------------------------------------------------------
  // XML 1.0 does not allow control characters in the .iflw; a line break in a name or id would also
  // start a new MANIFEST.MF header. Descriptions, bodies, values and code may span lines.
  const NAME_FIELD = /(^|\.)(id|name|packageId|system|fileName|address)$/
  walkStrings(spec, '', (value, path) => {
    // eslint-disable-next-line no-control-regex -- finding control characters is the point
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) err('CONTROL_CHARACTER', `${path || 'spec'}: contains a control character — remove it`)
    else if (NAME_FIELD.test(path) && /[\r\n\t]/.test(value)) err('LINE_BREAK', `${path}: must be one line — remove line breaks and tabs`)
  })

  // --- externalized parameters --------------------------------------------------
  const params = spec.parameters && typeof spec.parameters === 'object' ? spec.parameters : {}
  walkStrings({ trigger: spec.trigger, steps, end: spec.end, exceptionSubprocess: spec.exceptionSubprocess, localProcesses: spec.localProcesses }, '', (value, path) => {
    const refs = [...value.matchAll(PARAM_REF)]
    if (!refs.length) return
    // Groovy code, body and descriptions (documentation, not configuration) may contain {{ }} text
    if (/\.(code|body|description)$/.test(path)) return
    const row = /\.(headers|properties)\[\d+\]\.value$/.test(path)
    const rowType = row && specSteps.valueAt(spec, path.replace(/\.value$/, ''))?.type
    if (!PARAM_FIELDS.test(path) || (row && rowType !== 'constant')) {
      err('PARAM_NOT_URL', `${path}: parameters ({{…}}) can only be used as the whole url, credentialName or locationId of an HTTP receiver, the url of a SOAP receiver, the server, credentialName or to of a mail, or as a constant value`)
      return
    }
    if (!WHOLE_PARAM.test(value)) {
      err('PARAM_PARTIAL', `${path}: a parameter must be the whole value, e.g. "{{TargetURL}}", not part of a text`)
      return
    }
    const name = value.match(WHOLE_PARAM)[1]
    if (!Object.hasOwn(params, name)) err('PARAM_UNDEFINED', `${path}: parameter '${name}' is referenced but not defined in 'parameters'`)
  })

  const unique = issues.filter((i, n) => issues.findIndex((x) => x.message === i.message) === n)
  return { valid: unique.length === 0, errors: unique.map((i) => i.message), issues: unique, warnings }
}

/**
 * Header and property types: `expression` only when the value contains ${...}; a plain value is a
 * `constant` (CPI treats both alike, but constant states the intent and is what the CPI editor writes).
 * @returns {{ spec: object, fixes: string[] }} the spec with such rows set to constant, and what was fixed
 */
function normalizeTypes(spec) {
  if (!spec || typeof spec !== 'object') return { spec, fixes: [] }
  const fixes = []
  const fixRows = (rows, where) =>
    Array.isArray(rows)
      ? rows.map((r) => {
          if (r?.type !== 'expression' || String(r.value ?? '').includes('${')) return r
          fixes.push(`${where} ${r.name}`)
          return { ...r, type: 'constant' }
        })
      : rows
  const out = specSteps.mapSteps(spec, (s, where) =>
    s?.type === 'contentModifier'
      ? { ...s, ...(s.headers && { headers: fixRows(s.headers, `${s.name || where}: header`) }), ...(s.properties && { properties: fixRows(s.properties, `${s.name || where}: property`) }) }
      : s
  )
  return { spec: out, fixes }
}

module.exports = { validate, normalizeTypes, effectiveNames, hasScriptSecret, RECEIVER_STEPS, SUPPORTED_STEPS, SUPPORTED_EXCEPTION_STEPS, SUPPORTED_LOCAL_STEPS, MAIN_LINE_ONLY, DEFAULT_STEP_NAMES, GROOVY_IMPORT, GROOVY_ENTRY, schema }
