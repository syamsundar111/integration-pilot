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

const ajv = new Ajv({ allErrors: true, strict: false })
const checkSchema = ajv.compile(schema)

const SUPPORTED_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson', 'requestReplyHttp', 'writeVariables', 'router'] // router: main line only
// Steps allowed in the exception subprocess (no receivers there; Write Variables only in the main flow so far)
const SUPPORTED_EXCEPTION_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson']
const SUPPORTED_TRIGGERS = ['httpsSender', 'timer']
const MAX_MAIN_STEPS = 50 // main-flow steps, routers and the steps inside routes together
const SUPPORTED_ENDS = ['httpReceiver', 'none']

// Step kinds people (and LLMs) ask for that v1 deliberately does not build
const NOT_IN_V1 = /gateway|split|mapping|multicast|join|gather|aggregat|filter|sequential|parallel|loop|localprocess|xslt/i
// Error handling is supported, but as the top-level exceptionSubprocess field, not as a step
const EXCEPTION_STEP = /exception|error|subprocess|catch/i
// Start and end events are not steps: the trigger and the end are top-level fields
const END_STEP = /^(none|end|endEvent|messageEnd|httpReceiver)$/i
const TRIGGER_STEP = /^(start|startEvent|timer|httpsSender|sender)$/i

const DEFAULT_STEP_NAMES = {
  contentModifier: 'Content Modifier',
  groovyScript: 'Groovy Script',
  jsonToXml: 'JSON to XML Converter',
  xmlToJson: 'XML to JSON Converter',
  requestReplyHttp: 'Request Reply',
  writeVariables: 'Write Variables'
}
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
  const flatMain = specSteps.mainSteps(spec).filter((x) => x.step && typeof x.step === 'object') // main flow with the steps inside routes
  const explicit = new Set([...flatMain.map((x) => x.step), ...sub].map((s) => s?.name).filter(Boolean))
  // Defaults count per type across the main flow and the exception subprocess ("Content Modifier 1", "… 2")
  // and skip names given explicitly
  const name = (s) => {
    if (s.name) return s.name
    let n
    do n = `${DEFAULT_STEP_NAMES[s.type] || s.type} ${(counters[s.type] = (counters[s.type] || 0) + 1)}`
    while (explicit.has(n))
    return n
  }
  // names in flow order (a router's route steps right after it), so defaults count as the flow reads
  const named = new Map(flatMain.map((x) => [x.step, name(x.step)]))
  const steps = main.map((s) => named.get(s))
  const exception = sub.map(name)
  let rr = 0
  const systemOf = new Map(flatMain.map((x) => [x.step, x.step.type === 'requestReplyHttp' ? x.step.system || `Receiver${++rr}` : null]))
  const systems = main.map((s) => systemOf.get(s))
  // every main-flow step with its path, name and receiver: [{ step, where, name, system }]
  const flat = flatMain.map((x) => ({ ...x, name: named.get(x.step), system: systemOf.get(x.step) }))
  const endSystem = spec.end?.type === 'httpReceiver' ? spec.end.system || 'Receiver' : null
  const exceptionSubprocess = spec.exceptionSubprocess ? spec.exceptionSubprocess.name || DEFAULT_EXCEPTION_SUBPROCESS_NAME : null
  return { steps, systems, flat, endSystem, exceptionSubprocess, exceptionSteps: exception }
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
  locationId: 'use letters, digits, dot, dash or underscore, or a whole parameter like {{ErpLocation}}'
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
        push('MISSING_FIELD', `${where}: missing required field '${e.params.missingProperty}'`)
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
const STEP_PATH = String.raw`(steps\[\d+\](\.routes\[\d+\]\.steps\[\d+\])?|exceptionSubprocess\.steps\[\d+\])`
const PARAM_FIELDS = new RegExp(String.raw`^((${STEP_PATH}|end)\.(url|credentialName|locationId)|${STEP_PATH}\.(headers|properties)\[\d+\]\.value)$`)

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
  for (const { step: s, where, ptr, route } of specSteps.mainSteps(spec)) {
    const type = s?.type
    if (route && type === 'router') {
      skip.push(ptr)
      err('NESTED_ROUTER', `${where}: a router inside a route is not supported — routers sit on the main line only; put the routing on the main line, or decide it in a groovyScript that sets a property for the next router`)
      continue
    }
    if (!type || SUPPORTED_STEPS.includes(type)) continue
    skip.push(ptr)
    if (/router|gateway/i.test(type))
      err('USE_ROUTER', `${where}: '${type}' — a router is { "type": "router", "expressionType": "XML"|"NonXML", "routes": [{ "name", "condition", "steps"?, "end"? }, ..., { "name", "default": true }] }`)
    else if (END_STEP.test(type))
      err('END_AS_STEP', `${where}: '${type}' is the end of the flow, not a step — remove it from steps; the end is the top-level 'end' (or a route's 'end'), e.g. { "type": "none" }`)
    else if (TRIGGER_STEP.test(type))
      err('TRIGGER_AS_STEP', `${where}: '${type}' is the trigger, not a step — remove it from steps; the trigger is the top-level 'trigger', e.g. { "type": "timer", "mode": "once" }`)
    else if (EXCEPTION_STEP.test(type))
      err('EXCEPTION_AS_STEP', `${where}: error handling is not a step — remove '${type}' from steps and put the error handling steps into the top-level 'exceptionSubprocess': { "steps": [...] }`)
    else if (NOT_IN_V1.test(type))
      err(
        'STEP_NOT_IN_V1',
        `${where}: '${type}' is not supported yet (no splitter, multicast, join or mapping). Supported step types: ${supportedList}. Mapping logic can often be done in a groovyScript step.`
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
  if (spec.trigger?.type && !SUPPORTED_TRIGGERS.includes(spec.trigger.type)) {
    skip.push('/trigger')
    err('TRIGGER_UNSUPPORTED', `trigger: '${spec.trigger.type}' is not supported yet. Use httpsSender { address }, timer { mode: "once" } or timer { mode: "every", minutes }.`)
  }
  if (spec.end?.type && !SUPPORTED_ENDS.includes(spec.end.type)) {
    skip.push('/end')
    err('END_UNSUPPORTED', `end: '${spec.end.type}' is not supported in v1. Use httpReceiver { url, method, authType } or none.`)
  }

  // Receiver authentication, proxy and timeout: one actionable message per problem instead of schema noise
  const calls = specSteps
    .mainSteps(spec)
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

  if (!checkSchema(spec)) issues.push(...schemaErrors(checkSchema.errors, skip))

  // --- semantic rules (defensive: the spec may be partially invalid) ------------
  const isObj = (s) => s && typeof s === 'object'
  const steps = Array.isArray(spec.steps) ? spec.steps : []
  const subSteps = exceptionSteps(spec)
  const names = effectiveNames({
    ...spec,
    steps: steps.filter(isObj),
    ...(isObj(spec.exceptionSubprocess) && { exceptionSubprocess: { ...spec.exceptionSubprocess, steps: subSteps.filter(isObj) } })
  })
  // [step, path] of the main flow (with the steps inside routes) and the exception subprocess
  const allSteps = specSteps.allSteps(spec).map((x) => [x.step, x.where])

  const dupes = (list) => [...new Set(list.filter((v, i) => v && list.indexOf(v) !== i))]
  // where a duplicate is, and what to do: the model cannot fix "used more than once" without the positions
  const namedAt = [
    ...names.flat.map((x) => [x.name, x.where, x.step]),
    ...names.exceptionSteps.map((n, i) => [n, `exceptionSubprocess.steps[${i}]`, subSteps[i]]),
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
  for (const d of dupes([...names.flat.map((x) => x.name), ...names.exceptionSteps, names.exceptionSubprocess])) {
    const hits = namedAt.filter(([n]) => n === d)
    err('DUPLICATE_STEP_NAME', `steps: step name '${d}' is used more than once, at ${hits.map(([, p]) => p).join(' and ')} — step names must be unique (main flow, routes and exception subprocess together); ${fix(hits)}`)
  }
  for (const d of dupes([...names.flat.map((x) => x.system), names.endSystem]))
    err('DUPLICATE_SYSTEM', `receiver system name '${d}' is used more than once — give each receiver a unique 'system'`)
  for (const d of dupes(allSteps.filter(([s]) => s?.type === 'groovyScript').map(([s]) => s.fileName))) {
    const hits = allSteps.filter(([s]) => s?.type === 'groovyScript' && s.fileName === d).map(([st, p]) => [d, p, st])
    err('DUPLICATE_FILENAME', `steps: Groovy fileName '${d}' is used more than once, at ${hits.map(([, p]) => p).join(' and ')} — each script needs its own file; ${fix(hits)}`)
  }

  // --- end events: an escalation category only on an Escalation End, and one the references contain ---
  const ends = [
    ['end', spec.end],
    ['exceptionSubprocess.end', spec.exceptionSubprocess?.end],
    ...steps.flatMap((r, i) => (r?.type === 'router' && Array.isArray(r.routes) ? r.routes.map((x, j) => [`steps[${i}].routes[${j}].end`, x?.end]) : []))
  ].filter(([, e]) => isObj(e))
  for (const [where, e] of ends) {
    if (e.category != null && e.event !== 'escalation') err('CATEGORY_WITHOUT_ESCALATION', `${where}.category: only an Escalation End has a category — remove it, or set "event": "escalation"`)
    else if (e.event === 'escalation' && (e.category == null || schema.definitions.endEvent.properties.category.enum.includes(e.category)))
      valueCheck('Escalation End', [['category', e.category || cpiValues.DEFAULT_ESCALATION_CATEGORY]], where) // other values: the schema says which
  }

  // --- routers, ends, size ------------------------------------------------------------
  // Steps count together: main-flow steps, routers and the steps inside routes (route ends do not count)
  const total = names.flat.length
  if (total > MAX_MAIN_STEPS && steps.length <= MAX_MAIN_STEPS) err('TOO_MANY_STEPS', `steps: ${total} steps with the routers and the steps inside routes — at most ${MAX_MAIN_STEPS}; merge Content Modifiers or move logic into one Groovy script`)
  steps.forEach((r, i) => {
    if (r?.type !== 'router' || !Array.isArray(r.routes)) return
    const where = `steps[${i}]`
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
      const c = route.condition
      if (r.expressionType === 'NonXML') {
        if (!c.includes('${')) err('CONDITION_FORMAT', `${at}.condition: a NonXML condition reads a header or property with \${...}, e.g. "\${property.routeKey} = 'A'"`)
        // operators need spaces on both sides: ${property.x} = 'A', not ${property.x}='A'
        else if (/\S(=|!=|<=|>=|<|>|=~)\S/.test(c.replace(/\$\{[^}]*\}/g, (m) => m.replace(/[=<>!~]/g, '_')).replace(/'[^']*'/g, "''")))
          err('CONDITION_FORMAT', `${at}.condition: put spaces around the operator, e.g. "\${property.x} = 'A'", not "\${property.x}='A'"`)
      }
      if (r.expressionType === 'XML' && c.includes('${')) err('CONDITION_FORMAT', `${at}.condition: an XML condition is an XPath, e.g. "/root/type = 'X'"; for \${...} set expressionType "NonXML"`)
    })
    // a router whose routes all end must be the last step, and the main flow has no end of its own
    if (routes.length && routes.every((x) => x.end)) {
      if (i < steps.length - 1) err('ROUTER_ALL_END', `${where}: every route ends, so the steps after the router can never run — make the router the last step, or let a route continue (no 'end')`)
      if (spec.end && (spec.end.type !== 'none' || (spec.end.event && spec.end.event !== 'message')))
        err('ROUTER_ALL_END', `end: every route of the last router ends, so the main flow has no end of its own — set "end": { "type": "none" }`)
    }
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

  const httpCalls = steps.map((s, i) => [s, `steps[${i}]`]).filter(([s]) => s?.type === 'requestReplyHttp')
  if (spec.end?.type === 'httpReceiver') httpCalls.push([spec.end, 'end'])
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
  walkStrings({ trigger: spec.trigger, steps, end: spec.end, exceptionSubprocess: spec.exceptionSubprocess }, '', (value, path) => {
    const refs = [...value.matchAll(PARAM_REF)]
    if (!refs.length) return
    // Groovy code, body and descriptions (documentation, not configuration) may contain {{ }} text
    if (/\.(code|body|description)$/.test(path)) return
    const row = /\.(headers|properties)\[\d+\]\.value$/.test(path)
    const rowType = row && specSteps.valueAt(spec, path.replace(/\.value$/, ''))?.type
    if (!PARAM_FIELDS.test(path) || (row && rowType !== 'constant')) {
      err('PARAM_NOT_URL', `${path}: parameters ({{…}}) can only be used as the whole url, credentialName or locationId of an HTTP receiver, or as a constant value`)
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
  const fixStep = (s, i, prefix) =>
    s?.type === 'contentModifier'
      ? { ...s, ...(s.headers && { headers: fixRows(s.headers, `${s.name || `${prefix}[${i}]`}: header`) }), ...(s.properties && { properties: fixRows(s.properties, `${s.name || `${prefix}[${i}]`}: property`) }) }
      : s?.type === 'router' && Array.isArray(s.routes)
        ? {
            ...s,
            routes: s.routes.map((r, j) =>
              Array.isArray(r?.steps) ? { ...r, steps: r.steps.map((x, k) => fixStep(x, k, `${prefix}[${i}].routes[${j}].steps`)) } : r
            )
          }
        : s
  const out = {
    ...spec,
    ...(Array.isArray(spec.steps) && { steps: spec.steps.map((s, i) => fixStep(s, i, 'steps')) }),
    ...(Array.isArray(spec.exceptionSubprocess?.steps) && {
      exceptionSubprocess: { ...spec.exceptionSubprocess, steps: spec.exceptionSubprocess.steps.map((s, i) => fixStep(s, i, 'exceptionSubprocess.steps')) }
    })
  }
  return { spec: out, fixes }
}

module.exports = { validate, normalizeTypes, effectiveNames, hasScriptSecret, SUPPORTED_STEPS, SUPPORTED_EXCEPTION_STEPS, DEFAULT_STEP_NAMES, GROOVY_IMPORT, GROOVY_ENTRY, schema }
