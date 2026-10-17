/**
 * iFlow spec v1 validator: JSON Schema + semantic rules.
 * Returns human-readable errors an LLM (or a user) can act on directly.
 */
const Ajv = require('ajv')
const schema = require('./spec-schema.json')

const ajv = new Ajv({ allErrors: true, strict: false })
const checkSchema = ajv.compile(schema)

const SUPPORTED_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson', 'requestReplyHttp']
// Steps allowed in the exception subprocess (no receivers there in v1)
const SUPPORTED_EXCEPTION_STEPS = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson']
const SUPPORTED_TRIGGERS = ['httpsSender', 'timer']
const SUPPORTED_ENDS = ['httpReceiver', 'none']

// Step kinds people (and LLMs) ask for that v1 deliberately does not build
const NOT_IN_V1 = /router|gateway|split|mapping|multicast|join|gather|aggregat|filter|sequential|parallel|loop|localprocess|xslt/i
// Error handling is supported, but as the top-level exceptionSubprocess field, not as a step
const EXCEPTION_STEP = /exception|error|subprocess|catch/i

const DEFAULT_STEP_NAMES = {
  contentModifier: 'Content Modifier',
  groovyScript: 'Groovy Script',
  jsonToXml: 'JSON to XML Converter',
  xmlToJson: 'XML to JSON Converter',
  requestReplyHttp: 'Request Reply'
}
const DEFAULT_EXCEPTION_SUBPROCESS_NAME = 'Exception Subprocess 1'

const GROOVY_IMPORT = /import\s+com\.sap\.gateway\.ip\.core\.customdev\.util\.Message\s*;?/
const GROOVY_ENTRY = /def\s+Message\s+processData\s*\(\s*Message\s+message\s*\)/
const PARAM_REF = /\{\{\s*([^}]*?)\s*\}\}/g
const WHOLE_PARAM = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/
// v1 creates HTTP receivers with authentication None only (the only value in the reference exports)
const AUTH_HINT = 'create the receiver with authType None, then set authentication and credentials in the CPI web editor after creation'

const SECRET_NAME = /pass(word|wd)?|pwd|secret|api[-_]?key|token|authorization|client[-_]?secret/i

/** Steps of the exception subprocess, [] without one */
const exceptionSteps = (spec) => (Array.isArray(spec?.exceptionSubprocess?.steps) ? spec.exceptionSubprocess.steps : [])

/** Display names and receiver system names as the builder will use them */
function effectiveNames(spec) {
  const counters = {}
  const main = spec.steps || []
  const sub = exceptionSteps(spec)
  const explicit = new Set([...main, ...sub].map((s) => s.name).filter(Boolean))
  // Defaults count per type across the main flow and the exception subprocess ("Content Modifier 1", "… 2")
  // and skip names given explicitly
  const name = (s) => {
    if (s.name) return s.name
    let n
    do n = `${DEFAULT_STEP_NAMES[s.type] || s.type} ${(counters[s.type] = (counters[s.type] || 0) + 1)}`
    while (explicit.has(n))
    return n
  }
  const steps = main.map(name)
  const exception = sub.map(name)
  let rr = 0
  const systems = main.map((s) => (s.type === 'requestReplyHttp' ? s.system || `Receiver${++rr}` : null))
  const endSystem = spec.end?.type === 'httpReceiver' ? spec.end.system || 'Receiver' : null
  const exceptionSubprocess = spec.exceptionSubprocess ? spec.exceptionSubprocess.name || DEFAULT_EXCEPTION_SUBPROCESS_NAME : null
  return { steps, systems, endSystem, exceptionSubprocess, exceptionSteps: exception }
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
  name: 'use letters, digits, dot, dash or underscore'
}

/** Translates Ajv errors into plain sentences */
function schemaErrors(errors, skipPaths) {
  const out = []
  for (const e of errors) {
    if (e.keyword === 'if') continue // the specific error of the "then" branch is reported separately
    if (skipPaths.some((p) => e.instancePath === p || e.instancePath.startsWith(p + '/'))) continue
    if (e.keyword === 'additionalProperties' && e.params.additionalProperty === 'credentialAlias') continue // reported with AUTH_HINT
    const where = label(e.instancePath)
    const field = e.instancePath.split('/').pop()
    switch (e.keyword) {
      case 'required':
        out.push(`${where}: missing required field '${e.params.missingProperty}'`)
        break
      case 'additionalProperties':
        out.push(`${where}: unknown field '${e.params.additionalProperty}'`)
        break
      case 'enum':
        out.push(`${where}: must be one of ${e.params.allowedValues.join(', ')}`)
        break
      case 'const':
        out.push(`${where}: must be '${e.params.allowedValue}'`)
        break
      case 'pattern':
        out.push(`${where}: invalid value — ${PATTERN_HINTS[field] || `must match ${e.params.pattern}`}`)
        break
      case 'propertyNames':
        out.push(`${where}: invalid parameter name '${e.params.propertyName}' — start with a letter, then letters, digits or underscore`)
        break
      default:
        out.push(`${where}: ${e.message}`)
    }
  }
  return [...new Set(out)]
}

/** Visits every string in the spec with its path */
function walkStrings(node, path, fn) {
  if (typeof node === 'string') return fn(node, path)
  if (Array.isArray(node)) return node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, fn))
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walkStrings(v, path ? `${path}.${k}` : k, fn)
}

/** Fields where {{Parameter}} references are allowed: HTTP receiver URLs only in v1 */
const PARAM_FIELDS = /^(steps\[\d+\]|end)\.url$/

/**
 * @param {object} spec
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { valid: false, errors: ['spec: must be a JSON object'] }
  const errors = []
  const skip = []

  // Unsupported step/trigger/end types get one clear message instead of schema noise
  const supportedList = SUPPORTED_STEPS.join(', ')
  ;(Array.isArray(spec.steps) ? spec.steps : []).forEach((s, i) => {
    const type = s?.type
    if (!type || SUPPORTED_STEPS.includes(type)) return
    skip.push(`/steps/${i}`)
    errors.push(
      EXCEPTION_STEP.test(type)
        ? `steps[${i}]: error handling is not a step — remove '${type}' from steps and put the error handling steps into the top-level 'exceptionSubprocess': { "steps": [...] }`
        : NOT_IN_V1.test(type)
          ? `steps[${i}]: '${type}' is not supported in v1 — flows must be linear (no router, splitter, mapping). Supported step types: ${supportedList}. Routing or mapping logic can often be done in a groovyScript step.`
          : `steps[${i}]: unknown step type '${type}'. Supported step types: ${supportedList}.`
    )
  })
  const exceptionList = SUPPORTED_EXCEPTION_STEPS.join(', ')
  exceptionSteps(spec).forEach((s, i) => {
    const type = s?.type
    if (!type || SUPPORTED_EXCEPTION_STEPS.includes(type)) return
    skip.push(`/exceptionSubprocess/steps/${i}`)
    errors.push(
      type === 'requestReplyHttp'
        ? `exceptionSubprocess.steps[${i}]: requestReplyHttp is not supported in the exception subprocess in v1. Supported: ${exceptionList}. The subprocess result is returned to the sender.`
        : `exceptionSubprocess.steps[${i}]: '${type}' is not supported in the exception subprocess. Supported: ${exceptionList}.`
    )
  })
  if (spec.trigger?.type && !SUPPORTED_TRIGGERS.includes(spec.trigger.type)) {
    skip.push('/trigger')
    errors.push(`trigger: '${spec.trigger.type}' is not supported in v1. Use httpsSender { address } or timer { mode: "once" }.`)
  }
  if (spec.end?.type && !SUPPORTED_ENDS.includes(spec.end.type)) {
    skip.push('/end')
    errors.push(`end: '${spec.end.type}' is not supported in v1. Use httpReceiver { url, method, authType } or none.`)
  }

  // Receiver authentication: only None in v1; one actionable message instead of an enum error
  const calls = (Array.isArray(spec.steps) ? spec.steps : []).map((s, i) => [s, `steps[${i}]`, `/steps/${i}`]).filter(([s]) => s?.type === 'requestReplyHttp')
  if (spec.end?.type === 'httpReceiver') calls.push([spec.end, 'end', '/end'])
  for (const [call, where, ptr] of calls) {
    if (call.authType != null && call.authType !== 'None') {
      skip.push(`${ptr}/authType`)
      errors.push(`${where}.authType: '${call.authType}' is not supported in v1 — ${AUTH_HINT}`)
    }
    if ('credentialAlias' in call) errors.push(`${where}: credentialAlias is not supported in v1 — ${AUTH_HINT}`)
  }

  if (!checkSchema(spec)) errors.push(...schemaErrors(checkSchema.errors, skip))

  // --- semantic rules (defensive: the spec may be partially invalid) ------------
  const isObj = (s) => s && typeof s === 'object'
  const steps = Array.isArray(spec.steps) ? spec.steps : []
  const subSteps = exceptionSteps(spec)
  const names = effectiveNames({
    ...spec,
    steps: steps.filter(isObj),
    ...(isObj(spec.exceptionSubprocess) && { exceptionSubprocess: { ...spec.exceptionSubprocess, steps: subSteps.filter(isObj) } })
  })
  // [step, path] of the main flow and the exception subprocess
  const allSteps = [...steps.map((s, i) => [s, `steps[${i}]`]), ...subSteps.map((s, i) => [s, `exceptionSubprocess.steps[${i}]`])]

  const dupes = (list) => [...new Set(list.filter((v, i) => v && list.indexOf(v) !== i))]
  for (const d of dupes([...names.steps, ...names.exceptionSteps, names.exceptionSubprocess]))
    errors.push(`steps: step name '${d}' is used more than once — step names must be unique (main flow and exception subprocess together)`)
  for (const d of dupes([...names.systems, names.endSystem]))
    errors.push(`receiver system name '${d}' is used more than once — give each receiver a unique 'system'`)
  for (const d of dupes(allSteps.filter(([s]) => s?.type === 'groovyScript').map(([s]) => s.fileName)))
    errors.push(`steps: Groovy fileName '${d}' is used more than once — each script needs its own file`)

  for (const [s, where] of allSteps) {
    if (s?.type === 'groovyScript' && typeof s.code === 'string') {
      if (!GROOVY_IMPORT.test(s.code))
        errors.push(`${where}.code: Groovy script must import com.sap.gateway.ip.core.customdev.util.Message`)
      if (!GROOVY_ENTRY.test(s.code))
        errors.push(`${where}.code: Groovy script must define 'def Message processData(Message message)' and return the message`)
    }
  }

  const httpCalls = steps.map((s, i) => [s, `steps[${i}]`]).filter(([s]) => s?.type === 'requestReplyHttp')
  if (spec.end?.type === 'httpReceiver') httpCalls.push([spec.end, 'end'])
  for (const [call, where] of httpCalls)
    if (typeof call.url === 'string' && /^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(call.url))
      errors.push(`${where}.url: contains user:password — remove it; ${AUTH_HINT}`)

  // --- no plaintext secrets ------------------------------------------------------------
  for (const [s, where] of allSteps) {
    if (s?.type !== 'contentModifier') continue
    for (const table of ['headers', 'properties'])
      (Array.isArray(s[table]) ? s[table] : []).forEach((e, j) => {
        if (e?.type === 'constant' && SECRET_NAME.test(e.name || '') && e.value)
          errors.push(
            `${where}.${table}[${j}]: '${e.name}' looks like a secret with a constant value — never put passwords or tokens in the flow; set authentication on the receiver in the CPI web editor instead`
          )
      })
    if (typeof s.body === 'string' && /"(password|passwd|pwd|secret|client_secret|token)"\s*:\s*"[^"$]+"/i.test(s.body))
      errors.push(`${where}.body: contains a plaintext secret — never put passwords or tokens in the flow`)
  }
  for (const [s, where] of allSteps) {
    if (s?.type !== 'groovyScript' || typeof s.code !== 'string') continue
    if (/(password|passwd|pwd|secret|token)\w*\s*=\s*["'][^"'$]{3,}["']/i.test(s.code) || /Basic\s+[A-Za-z0-9+/]{12,}={0,2}/.test(s.code))
      errors.push(
        `${where}.code: contains a hard-coded secret — read credentials from deployed security material (SecureStoreService) instead`
      )
  }

  // --- externalized parameters --------------------------------------------------
  const params = spec.parameters && typeof spec.parameters === 'object' ? spec.parameters : {}
  walkStrings({ trigger: spec.trigger, steps, end: spec.end, exceptionSubprocess: spec.exceptionSubprocess }, '', (value, path) => {
    const refs = [...value.matchAll(PARAM_REF)]
    if (!refs.length) return
    // Groovy code and body may legitimately contain {{ }} text
    if (/\.(code|body)$/.test(path)) return
    if (!PARAM_FIELDS.test(path)) {
      errors.push(`${path}: parameters ({{…}}) can only be used as an HTTP receiver url in v1`)
      return
    }
    if (!WHOLE_PARAM.test(value)) {
      errors.push(`${path}: a parameter must be the whole value, e.g. "{{TargetURL}}", not part of a text`)
      return
    }
    const name = value.match(WHOLE_PARAM)[1]
    if (!(name in params)) errors.push(`${path}: parameter '${name}' is referenced but not defined in 'parameters'`)
  })

  return { valid: errors.length === 0, errors: [...new Set(errors)] }
}

module.exports = { validate, effectiveNames, SUPPORTED_STEPS, SUPPORTED_EXCEPTION_STEPS, DEFAULT_STEP_NAMES, schema }
