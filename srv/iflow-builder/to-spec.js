/**
 * Parsed iFlow (parser.js) -> iFlow spec v1, for updating an existing iFlow.
 *
 * An update rebuilds the whole iFlow from the spec, so anything the spec cannot express
 * would be lost silently. Such content is reported as a blocker, and the iFlow is not
 * offered for update.
 */
const fs = require('fs')
const path = require('path')
const { validate, SUPPORTED_STEPS, SUPPORTED_EXCEPTION_STEPS } = require('./validator')

const RESOURCES = 'src/main/resources/'

/**
 * Adapter settings that change behaviour and that the spec cannot hold. An update rebuilds the iFlow
 * with the builder's values (from its templates); an iFlow with another value would silently change,
 * e.g. a Cloud Connector receiver would become an Internet one. Version and name keys are left out.
 */
const SIGNIFICANT = {
  Receiver: ['proxyType', 'locationID', 'proxyHost', 'proxyPort', 'internetProxyType', 'httpRequestTimeout', 'httpShouldSendBody', 'throwExceptionOnFailure', 'httpErrorResponseCodes', 'allowedRequestHeaders', 'allowedResponseHeaders', 'retryOnConnectionFailure', 'retryOnException', 'retryIteration', 'retryInterval', 'streaming', 'privateKeyAlias'],
  Sender: ['senderAuthType', 'userRole', 'xsrfProtection', 'clientCertificates', 'maximumBodySize']
}
const TEMPLATE_DEFAULTS = (() => {
  const read = (f) => fs.readFileSync(path.join(__dirname, 'templates', 'iflw', f), 'utf8')
  const values = (xml) => Object.fromEntries([...xml.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)].map((m) => [m[1], m[2] ?? '']))
  return { Receiver: values(read('messageflow-http-receiver.xml')), Sender: values(read('messageflow-https-sender.xml')) }
})()
/** JSON<->XML converter settings the spec cannot hold: the builder writes its template values */
const CONVERTER_DEFAULTS = (() => {
  const read = (f) => fs.readFileSync(path.join(__dirname, 'templates', 'iflw', f), 'utf8')
  const values = (xml) =>
    Object.fromEntries(
      [...xml.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)]
        .filter((m) => !['componentVersion', 'activityType', 'cmdVariantUri'].includes(m[1]))
        .map((m) => [m[1], m[2] ?? ''])
    )
  return { jsonToXml: values(read('step-json-to-xml.xml')), xmlToJson: values(read('step-xml-to-json.xml')) }
})()
const LABELS = { proxyType: 'proxy type', locationID: 'Cloud Connector location ID', httpRequestTimeout: 'request timeout', senderAuthType: 'sender authentication', xsrfProtection: 'CSRF protection' }

/** Blockers for adapter settings an update would reset */
function adapterBlockers(adapters = []) {
  const out = []
  for (const a of adapters) {
    const kind = a.direction === 'Receiver' && a.type === 'HTTP' ? 'Receiver' : a.direction === 'Sender' && a.type === 'HTTPS' ? 'Sender' : null
    if (!kind || !a.settings) continue
    for (const key of SIGNIFICANT[kind]) {
      if (!(key in a.settings) || !(key in TEMPLATE_DEFAULTS[kind])) continue // older adapter versions lack some keys
      const have = String(a.settings[key] ?? '')
      const would = TEMPLATE_DEFAULTS[kind][key]
      if (have !== would)
        out.push(`${kind === 'Receiver' ? 'receiver' : 'sender'} ${a.system || a.name}: ${LABELS[key] || key} is '${have}'; an update would reset it to '${would || '(empty)'}'${key === 'proxyType' && have === 'sapcc' ? ' (Cloud Connector -> Internet)' : ''}`)
    }
  }
  return out
}

/** Spec step from a parsed step, or a blocker text */
function toStep(s, scripts, where) {
  const base = { type: s.type, ...(s.name && { name: s.name }) }
  switch (s.type) {
    case 'contentModifier': {
      const rows = (list = [], table) =>
        list.map((e) => {
          if (e.action && e.action !== 'Create') throw `${where} '${s.name}': ${table} '${e.name}' uses action '${e.action}' (only Create is supported)`
          if (!['constant', 'expression'].includes(e.type)) throw `${where} '${s.name}': ${table} '${e.name}' has source type '${e.type}' (only constant and expression are supported)`
          return { name: e.name, type: e.type, value: e.value ?? '', ...(e.datatype && { datatype: e.datatype }) }
        })
      const step = { ...base }
      if (s.headers?.length) step.headers = rows(s.headers, 'header')
      if (s.properties?.length) step.properties = rows(s.properties, 'property')
      if (s.body) step.body = s.body
      return step
    }
    case 'groovyScript': {
      if (s.function && s.function !== 'processData') throw `${where} '${s.name}': script function '${s.function}' (only processData is supported)`
      const file = scripts.find((f) => f.fileName === `${s.fileName}.groovy`)
      if (!file) throw `${where} '${s.name}': script ${s.fileName}.groovy not found in the iFlow`
      return { ...base, fileName: s.fileName, code: file.content }
    }
    case 'jsonToXml':
    case 'xmlToJson': {
      // e.g. a root element 'Orders' would become 'root': the payload format would change
      const defaults = CONVERTER_DEFAULTS[s.type]
      for (const [key, would] of Object.entries(defaults)) {
        if (!s.settings || !(key in s.settings)) continue // older converter versions lack some keys
        const have = String(s.settings[key] ?? '')
        if (have !== would) throw `${where} '${s.name}': ${key} is '${have}'; an update would reset it to '${would || '(empty)'}'`
      }
      return base
    }
    case 'requestReplyHttp':
      if (s.authType && s.authType !== 'None') throw `${where} '${s.name}': receiver ${s.system} uses authentication '${s.authType}', which an update would reset to None`
      return { ...base, ...(s.system && { system: s.system }), url: s.url, method: s.method, authType: 'None' }
    default:
      throw `${where} '${s.name}': step type '${s.activityType || s.type}' is not supported by the spec`
  }
}

/**
 * @param {object} parsed - result of parser.parse()
 * @param {{ packageId: string, configurations?: {key: string, value: string}[] }} options
 * @returns {{ spec: object|null, blockers: string[], resources?: Object<string, string> }} resources:
 *   content of the XSLT files listed in spec.resources
 */
function specFromParsed(parsed, { packageId, configurations = [] }) {
  const blockers = []
  const attempt = (fn) => {
    try {
      return fn()
    } catch (e) {
      if (typeof e !== 'string') throw e
      blockers.push(e)
      return null
    }
  }

  if (!parsed.linear) blockers.push('the flow branches (router, multicast or several paths)')
  if (parsed.localProcesses?.length) blockers.push(`local integration processes: ${parsed.localProcesses.join(', ')}`)

  const t = parsed.trigger || {}
  let trigger = null
  if (t.type === 'httpsSender') trigger = { type: 'httpsSender', address: t.address }
  else if (t.type === 'timer' && t.mode === 'once') trigger = { type: 'timer', mode: 'once' }
  else blockers.push(`trigger: ${t.type === 'timer' ? 'scheduled timer' : t.adapter || t.type} (only HTTPS sender or run-once timer)`)

  for (const a of parsed.adapters || [])
    if (!(a.type === 'HTTPS' && a.direction === 'Sender') && !(a.type === 'HTTP' && a.direction === 'Receiver')) blockers.push(`adapter ${a.type} (${a.direction || 'unknown direction'})`)

  const steps = (parsed.steps || []).map((s, i) =>
    SUPPORTED_STEPS.includes(s.type) ? attempt(() => toStep(s, parsed.scripts || [], `step ${i + 1}`)) : (blockers.push(`step ${i + 1} '${s.name}': ${s.activityType || s.type} is not supported by the spec`), null)
  )

  let exceptionSubprocess
  if (parsed.exceptionSubprocess) {
    const sub = parsed.exceptionSubprocess
    const subSteps = sub.steps.map((s, i) =>
      SUPPORTED_EXCEPTION_STEPS.includes(s.type)
        ? attempt(() => toStep(s, parsed.scripts || [], `exception subprocess step ${i + 1}`))
        : (blockers.push(`exception subprocess step ${i + 1} '${s.name}': ${s.activityType || s.type} is not supported there`), null)
    )
    if (!subSteps.length) blockers.push('the exception subprocess has no steps (the spec needs at least one)')
    exceptionSubprocess = { ...(sub.name && { name: sub.name }), steps: subSteps }
  }

  const e = parsed.end || {}
  let end = null
  if (e.type === 'none') end = { type: 'none' }
  else if (e.type === 'httpReceiver') {
    if (e.authType && e.authType !== 'None') blockers.push(`end receiver ${e.system} uses authentication '${e.authType}', which an update would reset to None`)
    else end = { type: 'httpReceiver', ...(e.system && { system: e.system }), url: e.url, method: e.method, authType: 'None' }
  } else blockers.push(`end: ${e.adapter || e.type} receiver (only HTTP receiver or none)`)

  // Resources the builder does not write (mappings, schemas, other scripts) would be deleted
  // XSLT files are kept as spec.resources (their content comes back in `resources`)
  const scripts = new Set([...(parsed.steps || []), ...(parsed.exceptionSubprocess?.steps || [])].filter((s) => s.type === 'groovyScript').map((s) => `script/${s.fileName}.groovy`))
  const mappings = Object.fromEntries((parsed.mappings || []).filter((m) => /^[A-Za-z][A-Za-z0-9_.-]*\.xslt?$/.test(m.fileName)).map((m) => [`mapping/${m.fileName}`, m]))
  for (const f of parsed.files || []) {
    if (!f.startsWith(RESOURCES)) continue
    const rel = f.slice(RESOURCES.length)
    if (rel.startsWith('scenarioflows/') || rel === 'parameters.prop' || rel === 'parameters.propdef' || scripts.has(rel) || mappings[rel]) continue
    blockers.push(`resource ${rel} (would be deleted by an update)`)
  }
  const resources = Object.fromEntries(Object.values(mappings).map((m) => [m.fileName, m.content]))

  // Current configured values win over the defaults in parameters.prop
  const parameters = { ...(parsed.parameters || {}) }
  for (const c of configurations) if (c.key in parameters || c.value) parameters[c.key] = c.value ?? ''

  // settings the spec cannot hold would be reset or dropped by an update: report them, never lose them
  blockers.push(...adapterBlockers(parsed.adapters))
  if ((parsed.exceptionSubprocessCount || 0) > 1)
    blockers.push(`${parsed.exceptionSubprocessCount} exception subprocesses (the spec holds one; an update would delete the others)`)

  if (blockers.length) return { spec: null, blockers }

  // a parameter address with a Query field ({{P}} + ?$format=json): the spec keeps url {{P}} and the
  // query in the parameter's default, as the builder expects (see splitParameters)
  // once per parameter: two receivers that share {{P}} both carry its query
  const rejoined = new Set()
  const rejoin = (call) => {
    const m = call?.url?.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}\?(.+)$/)
    if (!m || m[2].includes('{{')) return call
    if (!rejoined.has(m[1]) && !String(parameters[m[1]] ?? '').includes('?')) parameters[m[1]] = `${parameters[m[1]] ?? ''}?${m[2]}`
    rejoined.add(m[1])
    return { ...call, url: `{{${m[1]}}}` }
  }
  for (const list of [steps, exceptionSubprocess?.steps]) if (list) list.forEach((s, i) => (list[i] = s.type === 'requestReplyHttp' ? rejoin(s) : s))
  if (end?.type === 'httpReceiver') end = rejoin(end)

  const spec = {
    id: parsed.id,
    name: parsed.name,
    ...(parsed.description && { description: parsed.description }),
    packageId,
    trigger,
    steps,
    end,
    ...(exceptionSubprocess && { exceptionSubprocess }),
    ...(Object.keys(parameters).length && { parameters }),
    ...(Object.keys(resources).length && { resources: Object.keys(resources) })
  }
  const { valid, errors } = validate(spec, { attachments: Object.keys(resources) })
  if (!valid) return { spec: null, blockers: errors.map((err) => `not representable as a spec: ${err}`) }
  return { spec, blockers: [], resources }
}

/** Short, human-readable list of differences between two specs (for the update proposal) */
function describeChanges(before, after) {
  const changes = []
  const json = (v) => JSON.stringify(v ?? null)
  const stepList = (steps = []) => steps.map((s) => s.name || s.type).join(' → ') || '(none)'
  if (json(before.trigger) !== json(after.trigger)) changes.push(`trigger: ${json(before.trigger)} → ${json(after.trigger)}`)
  if (json(before.steps) !== json(after.steps)) changes.push(`steps: ${stepList(before.steps)}  ⇒  ${stepList(after.steps)}${stepList(before.steps) === stepList(after.steps) ? ' (step settings changed)' : ''}`)
  if (json(before.end) !== json(after.end)) changes.push(`end: ${json(before.end)} → ${json(after.end)}`)
  if (json(before.exceptionSubprocess) !== json(after.exceptionSubprocess)) {
    if (!before.exceptionSubprocess) changes.push(`exception subprocess added: ${stepList(after.exceptionSubprocess.steps)}`)
    else if (!after.exceptionSubprocess) changes.push('exception subprocess removed')
    else changes.push(`exception subprocess: ${stepList(before.exceptionSubprocess.steps)}  ⇒  ${stepList(after.exceptionSubprocess.steps)}`)
  }
  if (json(before.parameters) !== json(after.parameters)) changes.push(`parameters: ${Object.keys(before.parameters || {}).join(', ') || '(none)'} → ${Object.keys(after.parameters || {}).join(', ') || '(none)'}`)
  if (before.name !== after.name) changes.push(`name: ${before.name} → ${after.name}`)
  if ((before.description || '') !== (after.description || '')) changes.push('description changed')
  return changes
}

module.exports = { specFromParsed, describeChanges }
