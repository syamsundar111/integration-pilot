/**
 * iFlow parser: CPI iFlow zip -> structured summary for "Explain" features.
 * Works on any exported iFlow, not only on builder output: unknown steps are reported
 * with their CPI activityType, and non-linear flows are flagged (linear: false).
 */
const JSZip = require('jszip')
const { DOMParser } = require('@xmldom/xmldom')
const receiverSettings = require('./receiver-settings')
const cpiValues = require('./cpi-values')

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
/** Rows of a table without cell ids (Write Variables, timer schedule): [[cell, ...], ...] */
function parseCells(value) {
  if (!value) return []
  const doc = new DOMParser({ onError: () => {} }).parseFromString(`<rows>${value}</rows>`, 'text/xml')
  return childrenNamed(doc.documentElement, 'row').map((row) => childrenNamed(row, 'cell').map(text))
}

function parseTable(value) {
  if (!value) return []
  const doc = new DOMParser({ onError: () => {} }).parseFromString(`<rows>${value}</rows>`, 'text/xml')
  return childrenNamed(doc.documentElement, 'row').map((row) => {
    const cells = Object.fromEntries(childrenNamed(row, 'cell').map((c) => [c.getAttribute('id'), text(c)]))
    const entry = { name: cells.Name, type: cells.Type, value: cells.Value, action: cells.Action }
    if (cells.Datatype) entry.datatype = cells.Datatype
    if (cells.Default) entry.default = cells.Default
    return entry
  })
}

// --- adapters ------------------------------------------------------------------------

function adapterOf(flow) {
  const p = props(flow.node)
  const address = p.urlPath ?? (p.httpAddressWithoutQuery != null ? p.httpAddressWithoutQuery + (p.httpAddressQuery ? `?${p.httpAddressQuery}` : '') : (p.address ?? p.server))
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
  // all adapter settings, for update checks (not enumerable: summaries sent to the model stay small)
  Object.defineProperty(adapter, 'settings', { value: p, enumerable: false })
  return adapter
}

/**
 * An HTTP receiver call: what the spec holds (authentication as configured, the credential name, and
 * proxy, location ID and timeout when not the defaults), plus unsupportedSettings: what it cannot hold
 */
function httpCall(adapter) {
  const { settings, unsupported } = receiverSettings.fromCpi(adapter.settings)
  const { authType, credentialName, ...connection } = settings // proxyType, locationId, timeout
  return {
    system: adapter.system,
    url: adapter.address,
    method: adapter.method,
    authType: adapter.authType,
    credentialAlias: adapter.credentialAlias,
    ...connection,
    ...(unsupported.length && { unsupportedSettings: unsupported })
  }
}

/** A SOAP 1.x receiver call as the spec holds it; the other settings stay in step.settings, for updates and Import */
function soapCall(adapter) {
  const p = adapter.settings
  return {
    system: adapter.system,
    url: p.address,
    authType: p.authentication,
    credentialName: p.credentialName,
    proxyType: p.proxyType === 'sapcc' ? 'On-Premise' : p.proxyType,
    locationId: p.location_id,
    timeout: /^\d+$/.test(p.requestTimeout || '') ? Number(p.requestTimeout) : p.requestTimeout
  }
}

/** A Mail receiver as the spec holds it */
function mailCall(adapter) {
  const p = adapter.settings
  return { system: adapter.system, server: p.server, credentialName: p.user, from: p.from, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, body: p.body }
}

// --- steps ---------------------------------------------------------------------------

/**
 * @param {Element} node
 * @param {object} adaptersBySource - adapters by the id of the step they start from
 * @param {Object<string, string>} [processNames] - process names by id, for Process Calls
 */
function stepOf(node, adaptersBySource, processNames = {}) {
  const p = props(node)
  const base = { id: node.getAttribute('id'), name: node.getAttribute('name') }
  const local = node.localName
  if (local === 'exclusiveGateway') return { ...base, type: 'router' }
  if (local === 'parallelGateway') return { ...base, type: 'parallelMulticast' }
  // Message Mapping: an artifact (bundle id) or a mapping inside the iFlow; XSLT Mapping: a file. Settings for update checks
  if (p.activityType === 'Mapping' && (p.mappingType === 'MessageMapping' || p.subActivityType === 'XSLTMapping')) {
    const step =
      p.subActivityType === 'XSLTMapping'
        ? { ...base, type: 'xsltMapping', file: String(p.mappinguri || '').split('/').pop() }
        : { ...base, type: 'messageMapping', mapping: p.messageMappingBundleId || null, file: p.messageMappingBundleId ? null : `${p.mappingname}.mmap` }
    Object.defineProperty(step, 'settings', { value: p, enumerable: false })
    return step
  }

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
    case 'Variables': {
      // rows: name, data type, type, value, scope; step settings (visibility, encryption, expiry) for update checks
      const step = {
        ...base,
        type: 'writeVariables',
        variables: parseCells(p.variable).map(([name, datatype, type, value, scope]) => ({ name, type, value, ...(datatype && { datatype }), global: scope === 'global' }))
      }
      Object.defineProperty(step, 'settings', { value: p, enumerable: false })
      return step
    }
    case 'ProcessCallElement': {
      const processId = p.processId || p.subProcessId || null
      const step = { ...base, type: 'processCall', processId, process: processNames[processId] ?? null, activityType: p.activityType, subActivityType: p.subActivityType || null }
      // Looping Process Call: the condition and maximum are BPMN loop characteristics, the condition type a property
      const loop = child(node, 'standardLoopCharacteristics')
      if (p.subActivityType === 'LoopingProcess' && loop)
        step.loop = { condition: text(child(loop, 'loopCondition')).trim(), max: Number(loop.getAttribute('loopMaximum')) || null, expressionType: p.expressionType || null }
      Object.defineProperty(step, 'settings', { value: p, enumerable: false })
      return step
    }
    case 'Splitter': {
      // Iterating or General Splitter; the other split types (e.g. Tokenizer, PKCS#7) keep their splitType
      const kind = { IteratingSplitter: 'iterating', GeneralSplitter: 'general' }[p.splitType] || null
      const step = {
        ...base,
        type: 'splitter',
        kind,
        splitType: p.splitType || null,
        exprType: p.exprType || null,
        expression: p.splitExprValue ?? '',
        grouping: Number(p.grouping) || 1,
        streaming: p.Streaming === 'true',
        stopOnException: p.StopOnExecution === 'true',
        parallel: p.ParallelProcessing === 'true'
      }
      Object.defineProperty(step, 'settings', { value: p, enumerable: false })
      return step
    }
    case 'Gather': {
      const step = { ...base, type: 'gather', source: p.sourceXPath ?? '', target: p.targetXPath ?? '', messageType: p.messageType || null, aggregationAlgorithm: p.aggregationAlgorithm || null }
      Object.defineProperty(step, 'settings', { value: p, enumerable: false })
      return step
    }
    case 'JsonToXmlConverter':
    case 'XmlToJsonConverter': {
      const step = { ...base, type: p.activityType === 'JsonToXmlConverter' ? 'jsonToXml' : 'xmlToJson' }
      // all converter settings, for update checks (not enumerable, like adapter settings)
      Object.defineProperty(step, 'settings', { value: p, enumerable: false })
      return step
    }
    case 'ExternalCall': {
      const adapter = adaptersBySource[base.id]
      if (adapter?.type === 'HTTP') return { ...base, type: 'requestReplyHttp', ...httpCall(adapter) }
      if (adapter?.type === 'ProcessDirect') {
        const step = { ...base, type: 'requestReplyProcessDirect', system: adapter.system, address: adapter.address }
        Object.defineProperty(step, 'adapter', { value: adapter, enumerable: false })
        return step
      }
      if (adapter?.type === 'SOAP' && adapter.settings.MessageProtocol === 'SOAP 1.x') {
        const step = { ...base, type: 'requestReplySoap', ...soapCall(adapter) }
        Object.defineProperty(step, 'settings', { value: adapter.settings, enumerable: false })
        return step
      }
      return { ...base, type: 'requestReply', adapter: adapter || null }
    }
    case 'Send': {
      const adapter = adaptersBySource[base.id]
      if (adapter?.type !== 'Mail') return { ...base, type: 'send', activityType: p.activityType, adapter: adapter || null }
      const step = { ...base, type: 'sendMail', ...mailCall(adapter) }
      Object.defineProperty(step, 'settings', { value: adapter.settings, enumerable: false })
      return step
    }
    default:
      return { ...base, type: p.activityType ? p.activityType[0].toLowerCase() + p.activityType.slice(1) : local, activityType: p.activityType || null }
  }
}

/** The end of a process by the adapter on its end event: none, an HTTP or ProcessDirect receiver, or another receiver */
function receiverEnd(a) {
  if (!a) return { type: 'none' }
  if (a.type === 'HTTP') return { type: 'httpReceiver', ...httpCall(a) }
  if (a.type === 'ProcessDirect') {
    const end = { type: 'processDirectReceiver', system: a.system, address: a.address }
    Object.defineProperty(end, 'adapter', { value: a, enumerable: false })
    return end
  }
  return { type: 'receiver', adapter: a.type, system: a.system, address: a.address }
}

// --- flow walking ----------------------------------------------------------------------

/**
 * Flow nodes of a process or subprocess in processing order, walked from its start event
 * (breadth-first if it branches); unconnected nodes are appended.
 */
function walk(container, include = () => true) {
  const nodes = {}
  const outgoing = {}
  const flows = {} // source id -> [{ id, name, target, condition }]
  for (const el of elements(container)) {
    if (el.localName === 'extensionElements') continue
    if (el.localName === 'sequenceFlow') {
      ;(outgoing[el.getAttribute('sourceRef')] ||= []).push(el.getAttribute('targetRef'))
      const condition = text(child(el, 'conditionExpression')).trim() || props(el).expression || ''
      ;(flows[el.getAttribute('sourceRef')] ||= []).push({
        id: el.getAttribute('id'),
        name: el.getAttribute('name') || '',
        target: el.getAttribute('targetRef'),
        condition,
        expressionType: props(el).expressionType || ''
      })
    } else if (include(el)) nodes[el.getAttribute('id')] = el
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
  return { order, startNode, linear, nodes, flows }
}

/**
 * The main path of a branching flow: from the start event, at each fork the route with a condition
 * (not the router's default route) that has the most steps up to an end. The other routes are side
 * branches: their steps up to an end event, or up to the step where they rejoin the main path.
 * @returns {{ path: Element[], branches: Object<string, { route: string, condition: string, isDefault: boolean, steps: string[], end: string|null, rejoin: string|null }[]> }}
 */
function mainPath({ startNode, nodes, flows }) {
  if (!startNode) return { path: [], branches: {} }
  const out = (id) => (flows[id] || []).filter((f) => nodes[f.target])
  const memo = {}
  const longest = (id, stack = new Set()) => {
    if (id in memo) return memo[id]
    if (stack.has(id)) return 0 // a loop back
    stack.add(id)
    const n = nodes[id]
    const own = n && !['startEvent', 'endEvent'].includes(n.localName) ? 1 : 0
    const best = Math.max(0, ...out(id).map((f) => longest(f.target, stack)))
    stack.delete(id)
    return (memo[id] = own + best)
  }
  const isDefault = (id, f) => nodes[id].getAttribute('default') === f.id
  const choose = (id) => {
    const all = out(id)
    const conditional = all.filter((f) => !isDefault(id, f) && f.condition)
    const candidates = conditional.length ? conditional : all.filter((f) => !isDefault(id, f)).length ? all.filter((f) => !isDefault(id, f)) : all
    return candidates.reduce((best, f) => (longest(f.target) > longest(best.target) ? f : best))
  }

  const path = []
  const onPath = new Set()
  for (let id = startNode.getAttribute('id'); id && nodes[id] && !onPath.has(id); ) {
    path.push(nodes[id])
    onPath.add(id)
    id = out(id).length ? choose(id).target : null
  }

  const label = (n) => n.getAttribute('name') || n.localName
  const branches = {}
  for (const n of path) {
    const id = n.getAttribute('id')
    const all = out(id)
    if (all.length < 2) continue
    const main = choose(id)
    branches[id] = all.map((f, i) => {
      const steps = []
      let end = null
      let rejoin = null
      if (f !== main) {
        const queue = [f.target]
        const seen = new Set()
        while (queue.length) {
          const t = queue.shift()
          if (seen.has(t) || !nodes[t]) continue
          seen.add(t)
          if (onPath.has(t)) {
            rejoin ??= label(nodes[t])
            continue
          }
          if (nodes[t].localName === 'endEvent') end ??= label(nodes[t])
          else steps.push(label(nodes[t]))
          queue.push(...out(t).map((x) => x.target))
        }
      }
      return { route: f.name || `Route ${i + 1}`, condition: f.condition, isDefault: isDefault(id, f), main: f === main, steps, end, rejoin }
    })
  }
  return { path, branches }
}

/**
 * A branching flow as the spec holds it: main-line steps, where a router's routes either end or continue
 * with the step after the router (every continuing route joins there). Route steps are parsed steps, a
 * router is { type: 'router', name, expressionType, routes: [{ name, condition, default, steps, end }] }
 * with the default route last; end: { kind, name } of an ending route. A multicast on the main line is
 * { type: 'multicast', name, mode, join, branches: [{ name, steps }] }: every branch runs to one Join, the line
 * goes on after it. When the flow does not fit (a router inside a route, a route that goes back or joins
 * elsewhere, a fork that is not a router or multicast, a Terminate End): { unsupported: reason }.
 * @returns {{ steps: object[], endNode: Element|null } | { unsupported: string }}
 */
function routedFlow({ startNode, nodes, flows }, stepAt, { local = false } = {}) {
  const out = (id) => (flows[id] || []).filter((f) => nodes[f.target])
  const label = (n) => n.getAttribute('name') || n.getAttribute('id')
  const fail = (unsupported) => ({ unsupported })
  if (!startNode) return fail('no start event')
  const endOf = (n) => {
    const kind = endKind(n)
    if (kind === 'terminate') return null
    return { kind, name: n.getAttribute('name') || null, ...(kind === 'escalation' && { category: escalationCategory(n) }) }
  }
  // the nodes of a route from its first node: until an end event, or a gateway (where it stops)
  const follow = (first) => {
    const seq = []
    const seen = new Set()
    for (let id = first; id; ) {
      const n = nodes[id]
      if (!n || seen.has(id)) return { seq, loop: true }
      seen.add(id)
      if (n.localName === 'endEvent') return { seq, endNode: n }
      if (/Gateway$/.test(n.localName)) return { seq, stop: id }
      seq.push(id)
      const next = out(id)
      if (next.length !== 1) return { seq, fork: n }
      id = next[0].target
    }
    return { seq, loop: true }
  }

  const onMain = new Set()
  // sequential: the routing sequence; parallel: by name (Branch 1, Branch 2; the outgoing order is not the branch order)
  const branchFlows = (n) => {
    const sequence = [...String(props(n).routingSequenceTable || '').matchAll(/<cell>\d+<\/cell><cell>([^<]+)<\/cell>/g)].map((m) => m[1])
    const rank = (f) => (sequence.includes(f.id) ? sequence.indexOf(f.id) : sequence.length)
    return [...out(n.getAttribute('id'))].sort((a, b) => (sequence.length ? rank(a) - rank(b) : String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })))
  }
  /** A line from its first node: to the end of the flow, or in a multicast's branch to the Join ({ joinId }) */
  const line = (first, inBranch = false) => {
  const steps = []
  let next
  let id = first
  let endNode = null
  while (id) {
    const n = nodes[id]
    if (!n) return fail('a flow leads nowhere')
    if (n.localName === 'parallelGateway' && inBranch) {
      if (props(n).activityType === 'Join') return { steps, joinId: id }
      return fail(`${label(n)} is a multicast inside a multicast's branch`)
    }
    if (onMain.has(id)) return fail(`the flow goes back to ${label(n)}`)
    onMain.add(id)
    if (n.localName === 'endEvent') {
      if (!endOf(n)) return fail(`${label(n)} is a Terminate End`)
      endNode = n
      break
    }
    if (n.localName === 'parallelGateway') {
      const activity = props(n).activityType
      if (local || !['Multicast', 'SequentialMulticast'].includes(activity)) return fail(`${label(n)} is a multicast or join`)
      const branches = []
      let joinId = null
      for (const f of branchFlows(n)) {
        const b = line(f.target, true)
        if (b.unsupported) return b
        if (!b.joinId) return fail(`a branch of ${label(n)} does not reach a Join`)
        if (joinId && b.joinId !== joinId) return fail(`the branches of ${label(n)} do not meet at one Join`)
        joinId = b.joinId
        branches.push({ name: f.name || null, steps: b.steps })
      }
      if (!joinId) return fail(`${label(n)} has no branches`)
      steps.push({ ...stepAt(n), type: 'multicast', mode: activity === 'Multicast' ? 'parallel' : 'sequential', join: nodes[joinId].getAttribute('name') || null, branches })
      next = out(joinId)
      if (next.length !== 1) return fail(`${label(nodes[joinId])} has ${next.length} outgoing flows`)
      id = next[0].target
      continue
    }
    if (n.localName !== 'exclusiveGateway') {
      steps.push(stepAt(n))
      next = out(id)
      if (next.length !== 1) return fail(`${label(n)} has ${next.length} outgoing flows without a router`)
      id = next[0].target
      continue
    }
    // a router: routes that share no node with another route end on their own; the others continue to the
    // first node they share (the join), which must be the same for all of them
    // in the router's outgoing order (CPI's evaluation order; the flows' XML order may differ)
    const order = childrenNamed(n, 'outgoing').map((o) => text(o).trim())
    const rank = (f) => (order.includes(f.id) ? order.indexOf(f.id) : order.length)
    const routes = [...out(id)].sort((a, b) => rank(a) - rank(b)).map((f) => ({ f, ...follow(f.target) }))
    for (const r of routes) {
      if (r.loop) return fail(`route ${r.f.name || r.f.id} of ${label(n)} goes back`)
      if (r.fork) return fail(`route ${r.f.name || r.f.id} of ${label(n)} forks at ${label(r.fork)}`)
      if (r.endNode && !endOf(r.endNode)) return fail(`route ${r.f.name || r.f.id} of ${label(n)} ends with a Terminate End`)
      r.path = [...r.seq, r.stop || r.endNode.getAttribute('id')]
    }
    const uses = {}
    for (const r of routes) for (const x of new Set(r.path)) uses[x] = (uses[x] || 0) + 1
    for (const r of routes) r.join = r.path.find((x) => uses[x] > 1) ?? (r.stop || null)
    let continuing = routes.filter((r) => r.join)
    // no route continues, but one runs on to the line's end: on the main line the only route that ends with a Message
    // End, in a local process (where every End is plain) the default route. That route is the one that continues (the
    // builder writes both shapes alike; this is the spec's usual one, and an update keeps it)
    if (!continuing.length && !inBranch) {
      const toMessageEnd = routes.filter((r) => r.endNode && endKind(r.endNode) === 'message')
      const runsOn = local ? toMessageEnd.find((r) => r.f.id === n.getAttribute('default')) : toMessageEnd.length === 1 ? toMessageEnd[0] : null
      if (runsOn) {
        runsOn.join = runsOn.endNode.getAttribute('id')
        continuing = [runsOn]
      }
    }
    const join = continuing[0]?.join || null
    if (continuing.some((r) => r.join !== join)) return fail(`the routes of ${label(n)} do not join again at one step`)
    for (const r of routes) {
      r.own = r.join ? r.path.slice(0, r.path.indexOf(r.join)) : r.seq
      if (r.own.some((x) => /Gateway$/.test(nodes[x].localName))) return fail(`a route of ${label(n)} contains another router`)
    }
    const defaultId = n.getAttribute('default')
    // the condition type of the routes with a condition (CPI may store another one on the default route)
    const types = [...new Set(routes.filter((r) => r.f.id !== defaultId).map((r) => r.f.expressionType).filter(Boolean))]
    if (types.length > 1) return fail(`the routes of ${label(n)} mix expression types (${types.join(', ')})`)
    const toRoute = (r) => ({
      name: r.f.name || r.f.id,
      condition: r.f.condition || '',
      default: r.f.id === defaultId,
      steps: r.own.map((x) => stepAt(nodes[x])),
      end: r.join ? null : endOf(r.endNode)
    })
    // only one route continues: its steps are the main line after the router (same flow, easier to read)
    const single = continuing.length === 1 ? continuing[0] : null
    const mainAfter = single ? single.own : []
    if (single) single.own = []
    const parsed = routes.map(toRoute)
    steps.push({
      ...stepAt(n),
      type: 'router',
      expressionType: types[0] || null,
      routes: [...parsed.filter((r) => !r.default), ...parsed.filter((r) => r.default)] // the default route last
    })
    for (const x of mainAfter) {
      onMain.add(x)
      steps.push(stepAt(nodes[x]))
    }
    if (!join) break // every route ends: the router is the last step
    id = join
  }
  return { steps, endNode }
  }

  const started = out(startNode.getAttribute('id'))
  if (started.length !== 1) return fail(`the start event has ${started.length} outgoing flows`)
  return line(started[0].target)
}

/** 'escalation', 'error', 'terminate' or 'message' (a plain or message end) */
/** The category of an Escalation End (stored as ErrorCode, e.g. Others, RoutingConditionNotMet), else null */
function escalationCategory(node) {
  const def = node && child(node, 'escalationEventDefinition')
  return def ? props(def).ErrorCode || null : null
}

function endKind(node) {
  if (!node) return null
  if (child(node, 'escalationEventDefinition')) return 'escalation'
  if (child(node, 'errorEventDefinition')) return 'error'
  if (child(node, 'terminateEventDefinition')) return 'terminate'
  return 'message'
}

// --- main ----------------------------------------------------------------------------

/**
 * @param {Buffer|string} input - zip as Buffer or base64 string
 * @returns {Promise<{ id, name, description, trigger, steps, end, exceptionSubprocess, adapters, parameters, scripts, mappings, files, linear, mainPath, integrationProcesses, localProcesses, warnings }>}
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
  const flowsRaw = childrenNamed(collaboration, 'messageFlow').map((node) => ({ node, id: node.getAttribute('id'), source: node.getAttribute('sourceRef'), target: node.getAttribute('targetRef') }))
  const adapters = flowsRaw.map(adapterOf)
  const adaptersBySource = Object.fromEntries(adapters.map((a) => [a.source, a]))
  const adaptersByTarget = Object.fromEntries(adapters.map((a) => [a.target, a]))

  // Main integration process: the one that is not a local process (processType directCall). Not by
  // position or participant: local processes are "IntegrationProcess" participants too, and may come first.
  // A process that a (Looping, Idempotent) Process Call calls is local too: older exports may lack processType.
  const processes = childrenNamed(definitions, 'process')
  const processNames = Object.fromEntries(processes.map((p) => [p.getAttribute('id'), p.getAttribute('name')]))
  // the mapping files of the iFlow; a mapping inside it names its schemas, which may include others
  const resourceFiles = Object.keys(files)
    .filter((f) => /src\/main\/resources\/(mapping\/[^/]+\.(mmap|xslt?)|(xsd|wsdl)\/[^/]+)$/i.test(f))
    .map((f) => ({ fileName: f.split('/').pop(), path: f.slice(root.length), content: files[f] }))
  const schemaFiles = resourceFiles.filter((f) => /\.(xsd|wsdl)$/i.test(f.fileName))
  const schemasOf = (mmap) => {
    const seen = new Set()
    const visit = (content, pattern) => {
      for (const m of String(content).matchAll(pattern)) {
        const name = m[1].split('/').pop()
        const schema = schemaFiles.find((f) => f.fileName === name)
        if (schema && !seen.has(name)) {
          seen.add(name)
          visit(schema.content, /schemaLocation="([^"]+)"/g)
        }
      }
    }
    visit(resourceFiles.find((f) => f.fileName === mmap)?.content, /<elem>([^<]+\.(?:xsd|wsdl))<\/elem>/gi)
    return [...seen]
  }
  const stepAt = (n) => {
    const step = stepOf(n, adaptersBySource, processNames)
    if (step.type === 'messageMapping' && step.file) step.schemas = schemasOf(step.file)
    return step
  }
  const called = new Set([...definitions.getElementsByTagNameNS('*', 'callActivity')].map((el) => props(el).processId).filter(Boolean))
  const locals = processes.filter((p) => props(p).processType === 'directCall' || called.has(p.getAttribute('id')))
  // several: the one with a trigger (a start event with a timer or message definition) is the main flow
  const triggered = (p) => childrenNamed(p, 'startEvent').some((s) => elements(s).some((d) => /EventDefinition$/.test(d.localName)))
  const candidates = processes.filter((p) => !locals.includes(p))
  const main = candidates.find(triggered) || candidates[0] || processes[0]
  const integrationProcesses = candidates.length ? [main, ...candidates.filter((p) => p !== main)] : [] // the main flow first
  const warnings = []
  if (integrationProcesses.length > 1)
    warnings.push(
      `The iFlow has ${integrationProcesses.length} integration processes (${integrationProcesses.map((p) => `"${p.getAttribute('name')}"`).join(', ')}); only "${main.getAttribute('name')}" is shown as the main flow.`
    )
  else if (!integrationProcesses.length && main)
    warnings.push(`The iFlow has no integration process, only local processes; "${main.getAttribute('name')}" is shown as the main flow.`)

  // Exception subprocesses are reported separately, not as steps of the main flow
  const isExceptionSubprocess = (el) => el.localName === 'subProcess' && props(el).activityType === 'ErrorEventSubProcessTemplate'
  const mainWalk = walk(main, (el) => !isExceptionSubprocess(el))
  const { order, startNode, linear: mainLinear } = mainWalk
  let linear = mainLinear
  const exceptionSubprocesses = elements(main)
    .filter(isExceptionSubprocess)
    .map((el) => {
      const inner = walk(el)
      if (!inner.linear) linear = false
      return {
        id: el.getAttribute('id'),
        name: el.getAttribute('name'),
        steps: inner.order.filter((n) => !['startEvent', 'endEvent'].includes(n.localName)).map((n) => stepAt(n)),
        end: endKind(inner.order.find((n) => n.localName === 'endEvent')),
        endName: inner.order.find((n) => n.localName === 'endEvent')?.getAttribute('name') || null,
        endCategory: escalationCategory(inner.order.find((n) => n.localName === 'endEvent'))
      }
    })

  // Trigger
  let trigger = { type: 'none' }
  if (startNode) {
    const timerDef = child(startNode, 'timerEventDefinition')
    const startId = startNode.getAttribute('id')
    if (timerDef) {
      const schedule = props(timerDef).scheduleKey || ''
      // once; every N minutes in UTC (as the builder writes it); anything else is 'scheduled' with its schedule
      const plan = cpiValues.parseSchedule(String(Object.fromEntries(parseCells(schedule).map((c) => [c[0], c[1]])).schedule1 || '').replace(/&amp;/g, '&'))
      const every = plan.repeat === 'MINUTES' && /^\d+$/.test(plan.every || '') && plan.timeZone === cpiValues.TIME_ZONE ? Number(plan.every) : null
      trigger = {
        type: 'timer',
        name: startNode.getAttribute('name'),
        ...(plan.repeat === 'NONE' ? { mode: 'once' } : every ? { mode: 'every', minutes: every } : { mode: 'scheduled', schedule: plan })
      }
    } else if (adaptersByTarget[startId]) {
      const a = adaptersByTarget[startId]
      trigger = a.type === 'HTTPS' ? { type: 'httpsSender', address: a.address } : { type: 'sender', adapter: a.type, address: a.address }
    }
  }

  // Steps + end
  const steps = order.filter((n) => !['startEvent', 'endEvent'].includes(n.localName)).map((n) => stepAt(n))
  const endNodes = order.filter((n) => n.localName === 'endEvent')
  const endAdapter = endNodes.map((n) => adaptersBySource[n.getAttribute('id')]).find(Boolean)
  const end = receiverEnd(endAdapter)
  // an Error, Escalation or Terminate end (not a plain/message end): kept for update checks
  const mainEndKind = endNodes.length === 1 ? endKind(endNodes[0]) : null
  if (mainEndKind && mainEndKind !== 'message') end.kind = mainEndKind
  if (endNodes.length > 1) linear = false

  // Branching flows as the spec holds them: routers whose routes end or join again; end: the main end
  // (null when every route of the last router ends), with its kind
  let routed = null
  if (!mainLinear || endNodes.length > 1) {
    const r = routedFlow(mainWalk, stepAt)
    if (r.unsupported) routed = r
    else {
      const a = r.endNode && adaptersBySource[r.endNode.getAttribute('id')]
      const routedEnd = !r.endNode
        ? null
        : receiverEnd(a)
      if (routedEnd)
        Object.assign(routedEnd, {
          kind: endKind(r.endNode),
          name: r.endNode.getAttribute('name') || null,
          ...(endKind(r.endNode) === 'escalation' && { category: escalationCategory(r.endNode) })
        })
      routed = { steps: r.steps, end: routedEnd }
    }
  }

  // Branching flows: the main path alone, with its end, and what the side branches do
  let branching = null
  if (!mainLinear || endNodes.length > 1) {
    const { path, branches } = mainPath(mainWalk)
    const mainEndNode = path.at(-1)?.localName === 'endEvent' ? path.at(-1) : null
    const a = mainEndNode && adaptersBySource[mainEndNode.getAttribute('id')]
    branching = {
      steps: path.filter((n) => !['startEvent', 'endEvent'].includes(n.localName)).map((n) => ({ ...stepAt(n), ...(branches[n.getAttribute('id')] && { routes: branches[n.getAttribute('id')] }) })),
      end: receiverEnd(a)
    }
  }

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
  const mappings = Object.keys(files)
    .filter((f) => f.startsWith(root + 'src/main/resources/mapping/') && /\.xslt?$/i.test(f))
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
    mappings,
    resourceFiles, // mapping, schema and WSDL files with their content, for updates and Import
    linear,
    mainPath: branching, // branching flows only: { steps (routers carry routes), end }
    // branching flows only: the flow as the spec holds it ({ steps, end }), or { unsupported: reason }
    routed,
    exceptionSubprocess: exceptionSubprocesses[0] || null,
    exceptionSubprocessCount: exceptionSubprocesses.length,
    // names of all processes that are not local (normally one: the main flow); more than one is in warnings
    integrationProcesses: integrationProcesses.map((p) => p.getAttribute('name')),
    warnings, // for the user: what the parsed structure may not show correctly
    localProcesses: locals.filter((p) => p !== main).map((p) => p.getAttribute('name')),
    // their steps, for Import and updates: [{ id, name, steps, linear, routed, unsupported?, end }]
    localProcessSteps: locals
      .filter((p) => p !== main)
      .map((p) => {
        const w = walk(p)
        const ends = w.order.filter((n) => n.localName === 'endEvent')
        const linear = w.linear && ends.length <= 1
        // a local process with routers, as the spec holds it (like the main line), or { unsupported }
        const routed = linear ? null : routedFlow(w, stepAt, { local: true })
        const routable = routed && !routed.unsupported
        // end kinds of every end event: 'message' for a plain End; an Error or Escalation End otherwise
        const endKinds = [...new Set(ends.map(endKind))]
        return {
          id: p.getAttribute('id'),
          name: p.getAttribute('name'),
          linear,
          steps: routable ? routed.steps : w.order.filter((n) => !['startEvent', 'endEvent'].includes(n.localName)).map((n) => stepAt(n)),
          routed: !linear, // its steps are routers with their routes (when not unsupported)
          ...(routed?.unsupported && { unsupported: routed.unsupported }),
          end: endKinds.length === 1 ? endKinds[0] : endKinds.length ? endKinds.find((k) => k !== 'message') : null
        }
      }),
    files: Object.keys(zip.files).filter((f) => !zip.files[f].dir).map((f) => f.slice(root.length))
  }
}

module.exports = { parse, parseProperties, parseManifest, parseTable }
