/**
 * Parsed iFlow (parser.js) -> iFlow spec v1, for updating an existing iFlow.
 *
 * An update rebuilds the whole iFlow from the spec, so anything the spec cannot express
 * would be lost silently. Such content is reported as a blocker, and the iFlow is not
 * offered for update.
 */
const fs = require('fs')
const path = require('path')
const { validate, SUPPORTED_STEPS, SUPPORTED_EXCEPTION_STEPS, SUPPORTED_LOCAL_STEPS } = require('./validator')
const { AUTH_TYPES } = require('./receiver-settings')
const cpiValues = require('./cpi-values')
const senderSettings = require('./sender-settings')
const placeholders = require('./placeholders')
const schema = require('./spec-schema.json')
const ESCALATION_CATEGORIES = schema.definitions.endEvent.properties.category.enum

const RESOURCES = 'src/main/resources/'

/**
 * Adapter settings that change behaviour and that the spec cannot hold. An update rebuilds the iFlow
 * with the builder's values (from its templates); an iFlow with another value would silently change,
 * e.g. a Cloud Connector receiver would become an Internet one. Version and name keys are left out.
 */
const SIGNIFICANT = {
  // authentication, proxy type, location ID and timeout are in the spec (callFields); the rest is not
  Receiver: ['proxyHost', 'proxyPort', 'internetProxyType', 'httpShouldSendBody', 'throwExceptionOnFailure', 'httpErrorResponseCodes', 'allowedRequestHeaders', 'allowedResponseHeaders', 'retryOnConnectionFailure', 'retryOnException', 'retryIteration', 'retryInterval', 'streaming', 'privateKeyAlias'],
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
/** Write Variables step settings the spec cannot hold: the builder writes its template values */
const WRITE_VARIABLES_DEFAULTS = (() => {
  const xml = fs.readFileSync(path.join(__dirname, 'templates', 'iflw', 'step-write-variables.xml'), 'utf8')
  const all = Object.fromEntries([...xml.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)].map((m) => [m[1], m[2] ?? '']))
  return { visibility: all.visibility, encrypt: all.encrypt, expire: all.expire }
})()
/**
 * Splitter, Gather and Process Call settings the builder writes as fixed template values (the spec fields are
 * placeholders there): an iFlow with another value (e.g. a Tokenizer expression, parallel processing, another
 * aggregation algorithm) would be changed by an update
 */
const FIXED_SETTINGS = (() => {
  const read = (f) => fs.readFileSync(path.join(__dirname, 'templates', 'iflw', f), 'utf8')
  // versions and names differ by adapter release and do not change behaviour
  const NOT_SETTINGS = ['componentVersion', 'activityType', 'cmdVariantUri', 'ComponentNS', 'ComponentSWCVId', 'ComponentSWCVName', 'TransportProtocolVersion', 'MessageProtocolVersion', 'Name', 'Description']
  const fixed = (xml) =>
    Object.fromEntries(
      [...xml.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)]
        .filter((m) => !NOT_SETTINGS.includes(m[1]))
        .map((m) => [m[1], m[2] ?? ''])
    )
  return {
    iterating: fixed(read('step-splitter-iterating.xml')),
    general: fixed(read('step-splitter-general.xml')),
    gather: fixed(read('step-gather.xml')),
    processCall: fixed(read('step-process-call.xml')),
    loopingProcessCall: fixed(read('step-process-call-looping.xml')),
    soap: fixed(read('messageflow-soap-receiver.xml')),
    mail: fixed(read('messageflow-mail-receiver.xml')),
    messageMapping: fixed(read('step-message-mapping.xml')),
    xsltMapping: fixed(read('step-xslt-mapping.xml'))
  }
})()
/** Throws a blocker for a setting that differs from the builder's fixed value */
function checkFixed(s, fixed, what) {
  for (const [key, would] of Object.entries(fixed)) {
    if (!s.settings || !(key in s.settings)) continue // older versions lack some keys
    const have = String(s.settings[key] ?? '')
    if (have !== would) throw `${what}: ${key} is '${have}'; an update would reset it to '${would || '(empty)'}'`
  }
}
const LABELS = { senderAuthType: 'sender authentication', xsrfProtection: 'CSRF protection' }

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
        out.push(`${kind === 'Receiver' ? 'receiver' : 'sender'} ${a.system || a.name}: ${LABELS[key] || key} is '${have}'; an update would reset it to '${would || '(empty)'}'`)
    }
  }
  return out
}

/**
 * Spec fields of a parsed HTTP receiver call (request-reply step or end): authentication with its
 * credential name, proxy type, location ID and timeout. Throws a blocker text for settings the spec
 * cannot hold (parser: unsupportedSettings), so an update never resets them silently.
 */
function callFields(s, what) {
  if (s.unsupportedSettings?.length) throw `${what} uses ${s.unsupportedSettings.join(', ')}, which an update cannot keep`
  const auth = s.authType || 'None'
  if (!AUTH_TYPES.includes(auth)) throw `${what} uses authentication '${auth}', which an update cannot keep`
  return {
    ...(s.system && { system: s.system }),
    url: s.url,
    method: s.method,
    authType: auth,
    ...(auth !== 'None' && { credentialName: s.credentialAlias }),
    ...(s.proxyType && { proxyType: s.proxyType }),
    ...(s.locationId && { locationId: s.locationId }),
    ...(s.timeout && { timeout: s.timeout })
  }
}

/** Spec step from a parsed step, or a blocker text */
function toStep(s, scripts, files, where) {
  const base = { type: s.type, ...(s.name && { name: s.name }) }
  switch (s.type) {
    case 'contentModifier': {
      const rows = (list = [], table) =>
        list.map((e) => {
          if (e.action && e.action !== 'Create') throw `${where} '${s.name}': ${table} '${e.name}' uses action '${e.action}' (only Create is supported)`
          const type = cpiValues.cmTypeFromCpi(e.type)
          if (!type) throw `${where} '${s.name}': ${table} '${e.name}' has source type '${e.type}', which the spec cannot hold`
          return { name: e.name, type, value: e.value ?? '', ...(e.datatype && { datatype: e.datatype }), ...(e.default && { default: e.default }) }
        })
      const step = { ...base }
      if (s.headers?.length) step.headers = rows(s.headers, 'header')
      if (s.properties?.length) step.properties = rows(s.properties, 'property')
      if (s.body) step.body = s.body
      // a placeholder (an AI's PH_ step or Import's): its note is the REPLACE_WITH property, as the description is not
      // written into the iFlow; with the description back, it stays a placeholder (no deploy while one is left)
      if (placeholders.hasReplaceWith(step) && step.properties.find((p) => p.name === 'REPLACE_WITH').type === 'constant' && placeholders.usable(placeholders.noteOf(step)))
        step.description = `REPLACE WITH ${placeholders.noteOf(step)}`
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
      return { ...base, ...callFields(s, `${where} '${s.name}': receiver ${s.system}`) }
    case 'writeVariables': {
      // step settings the spec cannot hold (visibility, encryption, expiry): the builder writes its template values
      for (const [key, would] of Object.entries(WRITE_VARIABLES_DEFAULTS)) {
        if (!s.settings || !(key in s.settings)) continue
        const have = String(s.settings[key] ?? '')
        if (have !== would) throw `${where} '${s.name}': ${key} is '${have}'; an update would reset it to '${would || '(empty)'}'`
      }
      for (const v of s.variables) if (!cpiValues.WV_TYPES.includes(v.type)) throw `${where} '${s.name}': variable '${v.name}' has type '${v.type}', which the spec cannot hold`
      return { ...base, variables: s.variables.map((v) => ({ name: v.name, type: v.type, value: v.value ?? '', ...(v.datatype && { datatype: v.datatype }), ...(v.global && { global: true }) })) }
    }
    case 'splitter': {
      if (!s.kind) throw `${where} '${s.name}': a ${s.splitType || 'splitter'} is not supported by the spec (only Iterating and General Splitter)`
      checkFixed(s, FIXED_SETTINGS[s.kind], `${where} '${s.name}'`)
      if (s.kind === 'iterating' && s.settings?.tokenValue != null && s.settings.tokenValue !== s.expression)
        throw `${where} '${s.name}': tokenValue '${s.settings.tokenValue}' differs from the expression; an update would set it to '${s.expression}'`
      return { ...base, kind: s.kind, expression: s.expression, ...(s.grouping !== 1 && { grouping: s.grouping }), ...(!s.streaming && { streaming: false }), stopOnException: s.stopOnException }
    }
    case 'requestReplyProcessDirect': {
      const pd = senderSettings.processDirectReceiverOf(s.adapter)
      if (pd.differences) throw `${where} '${s.name}': receiver ${s.system}: ${pd.differences.join('; ')}`
      return { ...base, ...(s.system && { system: s.system }), address: pd.address }
    }
    case 'sendSftp': {
      const sftp = senderSettings.sftpReceiverOf(s.adapter)
      if (sftp.differences) throw `${where} '${s.name}': receiver ${s.system}: ${sftp.differences.join('; ')}`
      return { ...base, ...(s.system && { system: s.system }), ...sftp.call }
    }
    case 'requestReplySoap':
      checkFixed(s, FIXED_SETTINGS.soap, `${where} '${s.name}': receiver ${s.system}`)
      return {
        ...base,
        ...(s.system && { system: s.system }),
        url: s.url,
        authType: s.authType,
        credentialName: s.credentialName,
        proxyType: s.proxyType,
        ...(s.locationId && { locationId: s.locationId }),
        ...(s.timeout && s.timeout !== 60000 && { timeout: s.timeout })
      }
    case 'sendMail':
      checkFixed(s, FIXED_SETTINGS.mail, `${where} '${s.name}': receiver ${s.system}`)
      return {
        ...base,
        ...(s.system && { system: s.system }),
        server: s.server,
        credentialName: s.credentialName,
        from: s.from,
        to: s.to,
        ...(s.cc && { cc: s.cc }),
        ...(s.bcc && { bcc: s.bcc }),
        subject: s.subject,
        ...(s.body !== '${in.body}' && { body: s.body })
      }
    case 'messageMapping': {
      checkFixed(s, FIXED_SETTINGS.messageMapping, `${where} '${s.name}'`)
      if (s.mapping) return { ...base, mapping: s.mapping }
      if (!files.some((f) => f.fileName === s.file)) throw `${where} '${s.name}': the mapping ${s.file} is not in the iFlow`
      return { ...base, file: s.file, ...(s.schemas?.length && { schemas: s.schemas }) }
    }
    case 'xsltMapping':
      checkFixed(s, FIXED_SETTINGS.xsltMapping, `${where} '${s.name}'`)
      if (!files.some((f) => f.fileName === s.file)) throw `${where} '${s.name}': the XSLT file ${s.file} is not in the iFlow`
      return { ...base, file: s.file }
    case 'gather':
      checkFixed(s, FIXED_SETTINGS.gather, `${where} '${s.name}'`)
      if (s.aggregationAlgorithm === cpiValues.GATHER_AT_XPATH) return { ...base, source: s.source, target: s.target }
      if (s.aggregationAlgorithm !== cpiValues.GATHER_COMBINE) throw `${where} '${s.name}': aggregation '${s.aggregationAlgorithm}' is not supported by the spec (only Combine and Combine at XPath)`
      if (s.source || s.target) throw `${where} '${s.name}': a Combine with source or target XPath, which an update would remove`
      return base
    case 'processCall': {
      const looping = s.subActivityType === 'LoopingProcess'
      if (!looping && s.subActivityType !== 'NonLoopingProcess') throw `${where} '${s.name}': a ${s.subActivityType || 'process call'} is not supported by the spec (only Process Call and Looping Process Call)`
      if (!s.process) throw `${where} '${s.name}': the called process ${s.processId || ''} is not in the iFlow`
      checkFixed(s, FIXED_SETTINGS[looping ? 'loopingProcessCall' : 'processCall'], `${where} '${s.name}'`)
      if (looping && !(s.loop?.condition && s.loop.max)) throw `${where} '${s.name}': the loop has no condition or maximum`
      return { ...base, process: s.process, ...(looping && { loop: { condition: s.loop.condition, max: s.loop.max } }) }
    }
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

  // a branching flow: routers whose routes end or join again (parser: routed); anything else is a blocker
  const routed = !parsed.linear ? parsed.routed : null
  if (!parsed.linear && (!routed || routed.unsupported)) blockers.push(`the flow branches in a way the spec cannot hold${routed?.unsupported ? `: ${routed.unsupported}` : ''}`)
  if ((parsed.integrationProcesses?.length || 0) > 1) blockers.push(`${parsed.integrationProcesses.length} integration processes: ${parsed.integrationProcesses.join(', ')} (the spec holds one)`)

  const t = parsed.trigger || {}
  let trigger = null
  if (t.type === 'httpsSender') trigger = { type: 'httpsSender', address: t.address }
  else if (t.type === 'timer' && t.mode === 'once') trigger = { type: 'timer', mode: 'once' }
  else if (t.type === 'timer' && t.mode === 'every') trigger = { type: 'timer', mode: 'every', minutes: t.minutes }
  const sender = t.type === 'sender' ? senderSettings.triggerOf((parsed.adapters || []).find((a) => a.direction === 'Sender')) : null
  if (sender?.trigger) trigger = sender.trigger
  else if (!trigger)
    blockers.push(
      `trigger: ${t.type === 'timer' ? 'scheduled timer' : t.adapter ? `${t.adapter} sender` : t.type}${sender ? ` (${sender.differences.join('; ')})` : ''} (only HTTPS sender, SOAP, ProcessDirect, JMS or SFTP sender as the builder writes it, run-once timer or every N minutes in UTC)`
    )

  for (const a of parsed.adapters || [])
    if (!(['HTTPS', 'SOAP', 'ProcessDirect', 'JMS', 'SFTP'].includes(a.type) && a.direction === 'Sender') && !(['HTTP', 'SOAP', 'Mail', 'ProcessDirect', 'SFTP'].includes(a.type) && a.direction === 'Receiver')) blockers.push(`adapter ${a.type} (${a.direction || 'unknown direction'})`)

  const stepFrom = (s, where) =>
    SUPPORTED_STEPS.includes(s.type) && s.type !== 'router' && s.type !== 'multicast'
      ? attempt(() => toStep(s, parsed.scripts || [], parsed.resourceFiles || [], where))
      : (blockers.push(`${where} '${s.name}': ${s.activityType || s.type} is not supported by the spec`), null)
  const END_EVENTS = { message: 'message', escalation: 'escalation', error: 'error' } // terminate: not in the spec
  // an Escalation End's category must be one the spec allows; another (e.g. ReceiverNotFound) would be reset
  const categoryOf = (category, what) => {
    if (category && !ESCALATION_CATEGORIES.includes(category)) blockers.push(`${what} ends with an Escalation End of category '${category}', which an update cannot keep`)
    return category || undefined
  }
  const endFrom = (end, what) => ({
    event: END_EVENTS[end.kind] || 'message',
    ...(end.name && { name: end.name }),
    ...(end.kind === 'escalation' && end.category && { category: categoryOf(end.category, what) })
  })
  const routerFrom = (r, where, stepOf = stepFrom) => ({
    type: 'router',
    ...(r.name && { name: r.name }),
    expressionType: r.expressionType,
    routes: r.routes.map((route, j) => {
      if (route.end && !END_EVENTS[route.end.kind]) blockers.push(`${where} '${r.name}': route ${route.name} ends with a ${route.end.kind} end`)
      return {
        name: route.name,
        ...(route.default ? { default: true } : { condition: route.condition }),
        ...(route.steps.length && { steps: route.steps.map((x, k) => stepOf(x, `${where} route ${j + 1} step ${k + 1}`)) }),
        ...(route.end && { end: endFrom(route.end, `${where} '${r.name}': route ${route.name}`) })
      }
    })
  })
  const lineStep = (s, where) => (s.type === 'router' ? routerFrom(s, where) : s.type === 'multicast' ? multicastFrom(s, where) : stepFrom(s, where))
  const multicastFrom = (m, where) => ({
    type: 'multicast',
    ...(m.name && { name: m.name }),
    mode: m.mode,
    ...(m.join && { join: m.join }),
    branches: m.branches.map((b, j) => ({ ...(b.name && { name: b.name }), steps: b.steps.map((x, k) => lineStep(x, `${where} branch ${j + 1} step ${k + 1}`)) }))
  })
  const steps = (routed && !routed.unsupported ? routed.steps : parsed.steps || []).map((s, i) => (routed && !routed.unsupported ? lineStep(s, `step ${i + 1}`) : stepFrom(s, `step ${i + 1}`)))

  // local processes: routers as on the main line, plain End events only, steps a local process may hold
  const localProcesses = (parsed.localProcessSteps || []).map((lp) => {
    if (lp.unsupported) blockers.push(`local process ${lp.name} branches in a way the spec cannot hold: ${lp.unsupported}`)
    if (lp.end && lp.end !== 'message') blockers.push(`local process ${lp.name} ends with an ${lp.end} end (only a plain End)`)
    if (!lp.steps.length) blockers.push(`local process ${lp.name} has no steps (the spec needs at least one)`)
    const localStep = (s, where) =>
      SUPPORTED_LOCAL_STEPS.includes(s.type) && s.type !== 'router'
        ? attempt(() => toStep(s, parsed.scripts || [], parsed.resourceFiles || [], where))
        : (blockers.push(`${where} '${s.name}': ${s.activityType || s.type} is not supported there`), null)
    return {
      name: lp.name,
      steps: lp.steps.map((s, i) =>
        s.type === 'router' && lp.routed && !lp.unsupported ? routerFrom(s, `local process ${lp.name} step ${i + 1}`, localStep) : localStep(s, `local process ${lp.name} step ${i + 1}`)
      )
    }
  })

  // An empty exception subprocess that ends with an Error End (Error Start -> Error End, as the iGlow extension
  // adds one) changes nothing: a failing message ends as FAILED with or without it, so an update leaves it out
  const emptyErrorSubprocess = parsed.exceptionSubprocess && !parsed.exceptionSubprocess.steps.length && parsed.exceptionSubprocess.end === 'error'
  let exceptionSubprocess
  if (parsed.exceptionSubprocess && !emptyErrorSubprocess) {
    const sub = parsed.exceptionSubprocess
    const subSteps = sub.steps.map((s, i) =>
      SUPPORTED_EXCEPTION_STEPS.includes(s.type)
        ? attempt(() => toStep(s, parsed.scripts || [], parsed.resourceFiles || [], `exception subprocess step ${i + 1}`))
        : (blockers.push(`exception subprocess step ${i + 1} '${s.name}': ${s.activityType || s.type} is not supported there`), null)
    )
    if (!subSteps.length) blockers.push('the exception subprocess has no steps (the spec needs at least one)')
    const subEnd = END_EVENTS[sub.end] || null
    if (sub.end && !subEnd) blockers.push(`the exception subprocess ends with a ${sub.end} end (only Message, Escalation or Error End)`)
    exceptionSubprocess = {
      ...(sub.name && { name: sub.name }),
      steps: subSteps,
      ...(subEnd && subEnd !== 'message' && { end: endFrom({ kind: subEnd, name: sub.endName, category: sub.endCategory }, 'the exception subprocess') })
    }
  }

  // the main end: Message, Escalation or Error End (a receiver only with a Message End); none when every
  // route of the last router ends
  const e = routed && !routed.unsupported ? routed.end : parsed.end || {}
  let end = null
  if (!e) end = { type: 'none' }
  else if (e.kind && !END_EVENTS[e.kind]) blockers.push(`the main flow ends with a ${e.kind} end (only Message, Escalation or Error End)`)
  else if (e.type === 'none') end = { type: 'none', ...(e.kind && e.kind !== 'message' && { event: e.kind }), ...(e.kind === 'escalation' && e.category && { category: categoryOf(e.category, 'the main flow') }) }
  else if (e.type === 'httpReceiver') {
    if (e.kind && e.kind !== 'message') blockers.push(`the main flow ends with an ${e.kind} end and a receiver (a receiver needs a Message End)`)
    else attempt(() => (end = { type: 'httpReceiver', ...callFields(e, `end receiver ${e.system}`) }))
  } else if (e.type === 'processDirectReceiver') {
    const pd = senderSettings.processDirectReceiverOf(e.adapter)
    if (e.kind && e.kind !== 'message') blockers.push(`the main flow ends with an ${e.kind} end and a receiver (a receiver needs a Message End)`)
    else if (pd.differences) blockers.push(`end receiver ${e.system}: ${pd.differences.join('; ')}`)
    else end = { type: 'processDirectReceiver', ...(e.system && { system: e.system }), address: pd.address }
  } else blockers.push(`end: ${e.adapter || e.type} receiver (only HTTP or ProcessDirect receiver, or none)`)

  // Resources the builder does not write (mappings, schemas, other scripts) would be deleted
  // XSLT files are kept as spec.resources (their content comes back in `resources`)
  const nested = (list) => list.flatMap((s) => (s.type === 'router' ? s.routes.flatMap((x) => x.steps) : s.type === 'multicast' ? s.branches.flatMap((b) => [...b.steps, ...nested(b.steps)]) : []))
  const everyStep = [
    ...(parsed.steps || []),
    ...nested(routed?.steps || []),
    ...(parsed.exceptionSubprocess?.steps || []),
    ...(parsed.localProcessSteps || []).flatMap((lp) => lp.steps.flatMap((s) => [s, ...(s.routes || []).flatMap((r) => r.steps || [])]))
  ]
  const scripts = new Set(everyStep.filter((s) => s.type === 'groovyScript').map((s) => `script/${s.fileName}.groovy`))
  // files the mapping steps use: built from their step, not listed in spec.resources
  const stepFiles = new Set(everyStep.flatMap((s) => (s.type === 'xsltMapping' || s.type === 'messageMapping' ? [s.file, ...(s.schemas || [])].filter(Boolean) : [])))
  const usedFiles = (parsed.resourceFiles || []).filter((f) => stepFiles.has(f.fileName))
  const usedPaths = new Set(usedFiles.map((f) => f.path.slice(RESOURCES.length)))
  const mappings = Object.fromEntries((parsed.mappings || []).filter((m) => /^[A-Za-z][A-Za-z0-9_.-]*\.xslt?$/.test(m.fileName)).map((m) => [`mapping/${m.fileName}`, m]))
  for (const f of parsed.files || []) {
    if (!f.startsWith(RESOURCES)) continue
    const rel = f.slice(RESOURCES.length)
    if (rel.startsWith('scenarioflows/') || rel === 'parameters.prop' || rel === 'parameters.propdef' || scripts.has(rel) || mappings[rel] || usedPaths.has(rel)) continue
    blockers.push(`resource ${rel} (would be deleted by an update)`)
  }
  const resources = Object.fromEntries([...Object.values(mappings), ...usedFiles].map((m) => [m.fileName, m.content]))
  const specResources = Object.values(mappings).map((m) => m.fileName).filter((f) => !stepFiles.has(f))

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
  const routeLists = (list) =>
    list.flatMap((s) => (s?.type === 'router' ? s.routes.map((x) => x.steps).filter(Boolean) : s?.type === 'multicast' ? s.branches.flatMap((b) => [b.steps, ...routeLists(b.steps)]) : []))
  const lines = [steps, ...localProcesses.map((lp) => lp.steps)]
  for (const list of [...lines, ...lines.flatMap(routeLists), exceptionSubprocess?.steps]) if (list) list.forEach((s, i) => (list[i] = s?.type === 'requestReplyHttp' ? rejoin(s) : s))
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
    ...(localProcesses.length && { localProcesses }),
    ...(Object.keys(parameters).length && { parameters }),
    ...(specResources.length && { resources: specResources })
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
  if (json(before.localProcesses) !== json(after.localProcesses)) {
    const list = (sp) => (sp.localProcesses || []).map((lp) => `${lp.name}: ${stepList(lp.steps)}`).join('; ') || '(none)'
    changes.push(`local processes: ${list(before)}  ⇒  ${list(after)}`)
  }
  if (json(before.parameters) !== json(after.parameters)) changes.push(`parameters: ${Object.keys(before.parameters || {}).join(', ') || '(none)'} → ${Object.keys(after.parameters || {}).join(', ') || '(none)'}`)
  if (before.name !== after.name) changes.push(`name: ${before.name} → ${after.name}`)
  if ((before.description || '') !== (after.description || '')) changes.push('description changed')
  return changes
}

module.exports = { specFromParsed, describeChanges }
