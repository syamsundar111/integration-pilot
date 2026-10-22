/**
 * iFlow spec v1 validator: JSON Schema + semantic rules.
 * Returns human-readable errors an LLM (or a user) can act on directly, and the same
 * errors as issues with a stable code ({ code, message }) for compact tool results.
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
// Start and end events are not steps: the trigger and the end are top-level fields
const END_STEP = /^(none|end|endEvent|messageEnd|httpReceiver)$/i
const TRIGGER_STEP = /^(start|startEvent|timer|httpsSender|sender)$/i

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

/** Translates Ajv errors into plain sentences: [{ code, message }] */
function schemaErrors(errors, skipPaths) {
  const out = []
  const push = (code, message) => out.push({ code, message })
  for (const e of errors) {
    if (e.keyword === 'if') continue // the specific error of the "then" branch is reported separately
    if (skipPaths.some((p) => e.instancePath === p || e.instancePath.startsWith(p + '/'))) continue
    if (e.keyword === 'additionalProperties' && e.params.additionalProperty === 'credentialAlias') continue // reported with AUTH_HINT
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

/** Fields where {{Parameter}} references are allowed: HTTP receiver URLs only in v1 */
const PARAM_FIELDS = /^(steps\[\d+\]|end)\.url$/

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
  ;(Array.isArray(spec.steps) ? spec.steps : []).forEach((s, i) => {
    const type = s?.type
    if (!type || SUPPORTED_STEPS.includes(type)) return
    skip.push(`/steps/${i}`)
    if (END_STEP.test(type))
      err('END_AS_STEP', `steps[${i}]: '${type}' is the end of the flow, not a step — remove it from steps; the end is the top-level 'end', e.g. { "type": "none" }`)
    else if (TRIGGER_STEP.test(type))
      err('TRIGGER_AS_STEP', `steps[${i}]: '${type}' is the trigger, not a step — remove it from steps; the trigger is the top-level 'trigger', e.g. { "type": "timer", "mode": "once" }`)
    else if (EXCEPTION_STEP.test(type))
      err('EXCEPTION_AS_STEP', `steps[${i}]: error handling is not a step — remove '${type}' from steps and put the error handling steps into the top-level 'exceptionSubprocess': { "steps": [...] }`)
    else if (NOT_IN_V1.test(type))
      err(
        'STEP_NOT_IN_V1',
        `steps[${i}]: '${type}' is not supported in v1 — flows must be linear (no router, splitter, mapping). Supported step types: ${supportedList}. Routing or mapping logic can often be done in a groovyScript step.`
      )
    else err('UNKNOWN_STEP', `steps[${i}]: unknown step type '${type}'. Supported step types: ${supportedList}.`)
  })
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
    err('TRIGGER_UNSUPPORTED', `trigger: '${spec.trigger.type}' is not supported in v1. Use httpsSender { address } or timer { mode: "once" }.`)
  }
  if (spec.end?.type && !SUPPORTED_ENDS.includes(spec.end.type)) {
    skip.push('/end')
    err('END_UNSUPPORTED', `end: '${spec.end.type}' is not supported in v1. Use httpReceiver { url, method, authType } or none.`)
  }

  // Receiver authentication: only None in v1; one actionable message instead of an enum error
  const calls = (Array.isArray(spec.steps) ? spec.steps : []).map((s, i) => [s, `steps[${i}]`, `/steps/${i}`]).filter(([s]) => s?.type === 'requestReplyHttp')
  if (spec.end?.type === 'httpReceiver') calls.push([spec.end, 'end', '/end'])
  for (const [call, where, ptr] of calls) {
    if (call.authType != null && call.authType !== 'None') {
      skip.push(`${ptr}/authType`)
      err('AUTH_UNSUPPORTED', `${where}.authType: '${call.authType}' is not supported in v1 — ${AUTH_HINT}`)
    }
    if ('credentialAlias' in call) err('AUTH_UNSUPPORTED', `${where}: credentialAlias is not supported in v1 — ${AUTH_HINT}`)
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
  // [step, path] of the main flow and the exception subprocess
  const allSteps = [...steps.map((s, i) => [s, `steps[${i}]`]), ...subSteps.map((s, i) => [s, `exceptionSubprocess.steps[${i}]`])]

  const dupes = (list) => [...new Set(list.filter((v, i) => v && list.indexOf(v) !== i))]
  // where a duplicate is, and what to do: the model cannot fix "used more than once" without the positions
  const namedAt = [
    ...names.steps.map((n, i) => [n, `steps[${i}]`, steps[i]]),
    ...names.exceptionSteps.map((n, i) => [n, `exceptionSubprocess.steps[${i}]`, subSteps[i]]),
    [names.exceptionSubprocess, 'exceptionSubprocess.name', null]
  ]
  const fix = (hits) => {
    const same = hits.length > 1 && hits.every(([, , st]) => st && JSON.stringify(st) === JSON.stringify(hits[0][2]))
    const last = hits.at(-1)[1]
    const remove = (path) => {
      const m = path.match(/^(exceptionSubprocess\.)?steps\[(\d+)\]$/)
      return m ? `editDraftSpec {"op":"removeStep","index":${m[2]}${m[1] ? ',"exception":true' : ''}}` : `remove ${path}`
    }
    return same ? `the same step was added twice: remove ${last} (${remove(last)})` : `rename all but one, or remove the extra step (${remove(last)})`
  }
  for (const d of dupes([...names.steps, ...names.exceptionSteps, names.exceptionSubprocess])) {
    const hits = namedAt.filter(([n]) => n === d)
    err('DUPLICATE_STEP_NAME', `steps: step name '${d}' is used more than once, at ${hits.map(([, p]) => p).join(' and ')} — step names must be unique (main flow and exception subprocess together); ${fix(hits)}`)
  }
  for (const d of dupes([...names.systems, names.endSystem]))
    err('DUPLICATE_SYSTEM', `receiver system name '${d}' is used more than once — give each receiver a unique 'system'`)
  for (const d of dupes(allSteps.filter(([s]) => s?.type === 'groovyScript').map(([s]) => s.fileName))) {
    const hits = allSteps.filter(([s]) => s?.type === 'groovyScript' && s.fileName === d).map(([st, p]) => [d, p, st])
    err('DUPLICATE_FILENAME', `steps: Groovy fileName '${d}' is used more than once, at ${hits.map(([, p]) => p).join(' and ')} — each script needs its own file; ${fix(hits)}`)
  }

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
  const warnings = []
  for (const [call, where] of httpCalls) {
    if (typeof call.url === 'string' && /^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(call.url))
      err('URL_CREDENTIALS', `${where}.url: contains user:password — remove it; ${AUTH_HINT}`)
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
    if (/(password|passwd|pwd|secret|token)\w*\s*=\s*["'][^"'$]{3,}["']/i.test(s.code) || /Basic\s+[A-Za-z0-9+/]{12,}={0,2}/.test(s.code))
      err('SECRET', `${where}.code: contains a hard-coded secret — read credentials from deployed security material (SecureStoreService) instead`)
  }

  // --- externalized parameters --------------------------------------------------
  const params = spec.parameters && typeof spec.parameters === 'object' ? spec.parameters : {}
  walkStrings({ trigger: spec.trigger, steps, end: spec.end, exceptionSubprocess: spec.exceptionSubprocess }, '', (value, path) => {
    const refs = [...value.matchAll(PARAM_REF)]
    if (!refs.length) return
    // Groovy code, body and descriptions (documentation, not configuration) may contain {{ }} text
    if (/\.(code|body|description)$/.test(path)) return
    if (!PARAM_FIELDS.test(path)) {
      err('PARAM_NOT_URL', `${path}: parameters ({{…}}) can only be used as an HTTP receiver url in v1`)
      return
    }
    if (!WHOLE_PARAM.test(value)) {
      err('PARAM_PARTIAL', `${path}: a parameter must be the whole value, e.g. "{{TargetURL}}", not part of a text`)
      return
    }
    const name = value.match(WHOLE_PARAM)[1]
    if (!(name in params)) err('PARAM_UNDEFINED', `${path}: parameter '${name}' is referenced but not defined in 'parameters'`)
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

module.exports = { validate, normalizeTypes, effectiveNames, SUPPORTED_STEPS, SUPPORTED_EXCEPTION_STEPS, DEFAULT_STEP_NAMES, GROOVY_IMPORT, GROOVY_ENTRY, schema }
