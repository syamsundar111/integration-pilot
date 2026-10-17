/**
 * iFlow parser: CPI iFlow zip -> structured summary for "Explain" features.
 * Works on any exported iFlow, not only on builder output: unknown steps are reported
 * with their CPI activityType, and non-linear flows are flagged (linear: false).
 */
const JSZip = require('jszip')
const { DOMParser } = require('@xmldom/xmldom')

const IFLOW_DIR = 'src/main/resources/scenarioflows/integrationflow/'
const TEXT_EXT = /\.(iflw|groovy|gsh|js|xml|xsd|wsdl|xsl|xslt|mmap|json|edmx|prop|propdef|MF|project|txt)$/i

// --- small DOM helpers ---------------------------------------------------------

const elements = (node) => [...(node?.childNodes || [])].filter((n) => n.nodeType === 1)
const child = (node, local) => elements(node).find((e) => e.localName === local)
const childrenNamed = (node, local) => elements(node).filter((e) => e.localName === local)
const text = (node) => (node ? node.textContent : '')

/** ifl:property key/value pairs of the element's own extensionElements */
function props(node) {
  const out = {}
  for (const p of childrenNamed(child(node, 'extensionElements'), 'property')) {
    const key = text(child(p, 'key'))
    if (key) out[key] = text(child(p, 'value'))
  }
  return out
}

// --- bundle files ----------------------------------------------------------------

/** MANIFEST.MF headers (continuation lines start with a space) */
function parseManifest(mf = '') {
  const headers = {}
  let last
  for (const line of mf.split(/\r?\n/)) {
    if (line.startsWith(' ') && last) headers[last] += line.slice(1)
    else {
      const i = line.indexOf(':')
      if (i > 0) headers[(last = line.slice(0, i))] = line.slice(i + 1).trim()
    }
  }
  return headers
}

/** java.util.Properties format */
function parseProperties(src = '') {
  const out = {}
  const logical = src.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)
  for (const raw of logical) {
    const line = raw.replace(/^\s+/, '')
    if (!line || line[0] === '#' || line[0] === '!') continue
    let i = 0
    while (i < line.length && !('=:'.includes(line[i]) && line[i - 1] !== '\\') && !(line[i] === ' ' && line[i - 1] !== '\\')) i++
    const key = unescapeProp(line.slice(0, i))
    const value = unescapeProp(line.slice(i).replace(/^\s*[=:]?\s*/, ''))
    out[key] = value
  }
  return out
}

function unescapeProp(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16))
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c
  })
}

/** Rows of a Content Modifier headerTable/propertyTable (the value is escaped XML) */
function parseTable(value) {
  if (!value) return []
  const doc = new DOMParser({ onError: () => {} }).parseFromString(`<rows>${value}</rows>`, 'text/xml')
  return childrenNamed(doc.documentElement, 'row').map((row) => {
    const cells = Object.fromEntries(childrenNamed(row, 'cell').map((c) => [c.getAttribute('id'), text(c)]))
    const entry = { name: cells.Name, type: cells.Type, value: cells.Value, action: cells.Action }
    if (cells.Datatype) entry.datatype = cells.Datatype
    return entry
  })
}

// --- adapters ------------------------------------------------------------------------

function adapterOf(flow) {
  const p = props(flow.node)
  const address = p.urlPath ?? (p.httpAddressWithoutQuery != null ? p.httpAddressWithoutQuery + (p.httpAddressQuery ? `?${p.httpAddressQuery}` : '') : p.address)
  const adapter = {
    id: flow.id,
    name: flow.node.getAttribute('name'),
    type: p.ComponentType || flow.node.getAttribute('name'),
    direction: p.direction,
    system: p.system,
    address: address ?? null,
    source: flow.source,
    target: flow.target
  }
  if (p.httpMethod) adapter.method = p.httpMethod
  if (p.authenticationMethod) adapter.authType = p.authenticationMethod // as configured in CPI, e.g. None
  if (p.senderAuthType) adapter.authType = p.senderAuthType
  if (p.credentialName) adapter.credentialAlias = p.credentialName
  return adapter
}

// --- steps ---------------------------------------------------------------------------

function stepOf(node, adaptersBySource) {
  const p = props(node)
  const base = { id: node.getAttribute('id'), name: node.getAttribute('name') }
  const local = node.localName
  if (local === 'exclusiveGateway') return { ...base, type: 'router' }
  if (local === 'parallelGateway') return { ...base, type: 'parallelMulticast' }

  switch (p.activityType) {
    case 'Enricher': {
      const step = { ...base, type: 'contentModifier', headers: parseTable(p.headerTable), properties: parseTable(p.propertyTable) }
      if (p.wrapContent) step.body = p.wrapContent
      return step
    }
    case 'Script':
      if (p.subActivityType === 'GroovyScript')
        return { ...base, type: 'groovyScript', fileName: (p.script || '').replace(/\.groovy$/, ''), script: p.script, function: p.scriptFunction || 'processData' }
      return { ...base, type: 'script', language: p.subActivityType, script: p.script }
    case 'JsonToXmlConverter':
      return { ...base, type: 'jsonToXml' }
    case 'XmlToJsonConverter':
      return { ...base, type: 'xmlToJson' }
    case 'ExternalCall': {
      const adapter = adaptersBySource[base.id]
      if (adapter?.type === 'HTTP')
        return { ...base, type: 'requestReplyHttp', system: adapter.system, url: adapter.address, method: adapter.method, authType: adapter.authType, credentialAlias: adapter.credentialAlias }
      return { ...base, type: 'requestReply', adapter: adapter || null }
    }
    default:
      return { ...base, type: p.activityType ? p.activityType[0].toLowerCase() + p.activityType.slice(1) : local, activityType: p.activityType || null }
  }
}

// --- flow walking ----------------------------------------------------------------------

/**
 * Flow nodes of a process or subprocess in processing order, walked from its start event
 * (breadth-first if it branches); unconnected nodes are appended.
 */
function walk(container, include = () => true) {
  const nodes = {}
  const outgoing = {}
  for (const el of elements(container)) {
    if (el.localName === 'extensionElements') continue
    if (el.localName === 'sequenceFlow') (outgoing[el.getAttribute('sourceRef')] ||= []).push(el.getAttribute('targetRef'))
    else if (include(el)) nodes[el.getAttribute('id')] = el
  }
  const startNode = Object.values(nodes).find((n) => n.localName === 'startEvent')
  const order = []
  const seen = new Set()
  let linear = true
  const queue = startNode ? [startNode.getAttribute('id')] : []
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id) || !nodes[id]) continue
    seen.add(id)
    order.push(nodes[id])
    const next = outgoing[id] || []
    if (next.length > 1) linear = false
    queue.push(...next)
  }
  for (const [id, n] of Object.entries(nodes)) if (!seen.has(id)) order.push(n) // unconnected leftovers
  return { order, startNode, linear }
}

// --- main ----------------------------------------------------------------------------

/**
 * @param {Buffer|string} input - zip as Buffer or base64 string
 * @returns {Promise<{ id, name, description, trigger, steps, end, exceptionSubprocess, adapters, parameters, scripts, files, linear }>}
 */
async function parse(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'base64')
  let zip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw Object.assign(new Error('Not a valid zip file'), { code: 'INVALID_ZIP', status: 400, hint: 'Upload the .zip of a single iFlow (iFlows page → Download ZIP, or Export in the CPI web editor).' })
  }

  const files = {}
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir && TEXT_EXT.test(name)) files[name] = await entry.async('string')

  const iflwPath = Object.keys(files).find((f) => f.includes(IFLOW_DIR) && f.endsWith('.iflw'))
  if (!iflwPath) {
    // A package export holds its artifacts as nested entries plus resources.cnt/contentmetadata.md
    const isPackage = Object.keys(zip.files).some((f) => /(^|\/)(resources\.cnt|contentmetadata\.md)$/.test(f))
    throw Object.assign(new Error(isPackage ? 'This is a package export, not a single iFlow.' : 'No .iflw found in the zip — is this an integration flow export?'), {
      code: 'INVALID_IFLOW',
      status: 400,
      hint: 'Upload the .zip of a single iFlow (iFlows page → Download ZIP, or Export in the CPI web editor).'
    })
  }
  // Tolerate exports wrapped in a top-level folder
  const root = iflwPath.slice(0, iflwPath.indexOf('src/main/resources/'))
  const file = (p) => files[root + p]

  const manifest = parseManifest(file('META-INF/MANIFEST.MF'))
  const meta = parseProperties(file('metainfo.prop'))

  const doc = new DOMParser({ onError: () => {} }).parseFromString(files[iflwPath], 'text/xml')
  const definitions = doc.documentElement
  if (!definitions || definitions.localName !== 'definitions') throw Object.assign(new Error('The .iflw is not valid BPMN XML'), { code: 'INVALID_IFLOW', status: 400 })

  const collaboration = child(definitions, 'collaboration')
  const participants = Object.fromEntries(
    childrenNamed(collaboration, 'participant').map((p) => [p.getAttribute('id'), { name: p.getAttribute('name'), type: p.getAttribute('ifl:type'), processRef: p.getAttribute('processRef') }])
  )
  const flowsRaw = childrenNamed(collaboration, 'messageFlow').map((node) => ({ node, id: node.getAttribute('id'), source: node.getAttribute('sourceRef'), target: node.getAttribute('targetRef') }))
  const adapters = flowsRaw.map(adapterOf)
  const adaptersBySource = Object.fromEntries(adapters.map((a) => [a.source, a]))
  const adaptersByTarget = Object.fromEntries(adapters.map((a) => [a.target, a]))

  // Main integration process (local processes are listed separately)
  const processes = childrenNamed(definitions, 'process')
  const mainRef = Object.values(participants).find((p) => p.type === 'IntegrationProcess')?.processRef
  const main = processes.find((p) => p.getAttribute('id') === mainRef) || processes[0]

  // Exception subprocesses are reported separately, not as steps of the main flow
  const isExceptionSubprocess = (el) => el.localName === 'subProcess' && props(el).activityType === 'ErrorEventSubProcessTemplate'
  const { order, startNode, linear: mainLinear } = walk(main, (el) => !isExceptionSubprocess(el))
  let linear = mainLinear
  const exceptionSubprocesses = elements(main)
    .filter(isExceptionSubprocess)
    .map((el) => {
      const inner = walk(el)
      if (!inner.linear) linear = false
      return {
        id: el.getAttribute('id'),
        name: el.getAttribute('name'),
        steps: inner.order.filter((n) => !['startEvent', 'endEvent'].includes(n.localName)).map((n) => stepOf(n, adaptersBySource))
      }
    })

  // Trigger
  let trigger = { type: 'none' }
  if (startNode) {
    const timerDef = child(startNode, 'timerEventDefinition')
    const startId = startNode.getAttribute('id')
    if (timerDef) {
      const schedule = props(timerDef).scheduleKey || ''
      trigger = { type: 'timer', name: startNode.getAttribute('name'), mode: /simple\.repeat=NONE/.test(schedule) ? 'once' : 'scheduled' }
    } else if (adaptersByTarget[startId]) {
      const a = adaptersByTarget[startId]
      trigger = a.type === 'HTTPS' ? { type: 'httpsSender', address: a.address } : { type: 'sender', adapter: a.type, address: a.address }
    }
  }

  // Steps + end
  const steps = order.filter((n) => !['startEvent', 'endEvent'].includes(n.localName)).map((n) => stepOf(n, adaptersBySource))
  const endNodes = order.filter((n) => n.localName === 'endEvent')
  const endAdapter = endNodes.map((n) => adaptersBySource[n.getAttribute('id')]).find(Boolean)
  const end = !endAdapter
    ? { type: 'none' }
    : endAdapter.type === 'HTTP'
      ? { type: 'httpReceiver', system: endAdapter.system, url: endAdapter.address, method: endAdapter.method, authType: endAdapter.authType, credentialAlias: endAdapter.credentialAlias }
      : { type: 'receiver', adapter: endAdapter.type, system: endAdapter.system, address: endAdapter.address }
  if (endNodes.length > 1) linear = false

  // Parameters: values from parameters.prop, names also from parameters.propdef
  const parameters = parseProperties(file('src/main/resources/parameters.prop'))
  const propdef = file('src/main/resources/parameters.propdef')
  if (propdef) {
    const pd = new DOMParser({ onError: () => {} }).parseFromString(propdef, 'text/xml')
    for (const p of childrenNamed(pd.documentElement, 'parameter')) {
      const name = text(child(p, 'name'))
      if (name && !(name in parameters)) parameters[name] = ''
    }
  }

  const scripts = Object.keys(files)
    .filter((f) => f.startsWith(root + 'src/main/resources/script/'))
    .map((f) => ({ fileName: f.split('/').pop(), path: f.slice(root.length), content: files[f] }))

  for (const a of adapters) delete a.node
  return {
    id: (manifest['Bundle-SymbolicName'] || '').split(';')[0].trim() || null,
    name: manifest['Bundle-Name'] || null,
    description: meta.description || '',
    trigger,
    steps,
    end,
    adapters,
    parameters,
    scripts,
    linear,
    exceptionSubprocess: exceptionSubprocesses[0] || null,
    localProcesses: processes.filter((p) => p !== main).map((p) => p.getAttribute('name')),
    files: Object.keys(zip.files).filter((f) => !zip.files[f].dir).map((f) => f.slice(root.length))
  }
}

module.exports = { parse, parseProperties, parseManifest, parseTable }
