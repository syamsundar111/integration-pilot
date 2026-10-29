/**
 * iFlow builder: spec (v1) -> CPI iFlow zip.
 *
 * All XML comes from ./templates, which derive-templates.js cut out of the reference
 * exports, so cmdVariantUri, componentVersion and property keys match what the CPI
 * web editor writes. This module only fills placeholders, generates element ids and
 * computes the diagram layout.
 */
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const { validate, effectiveNames } = require('./validator')
const receiverSettings = require('./receiver-settings')
const cpiValues = require('./cpi-values')
const specSteps = require('./spec-steps')

const TEMPLATE_DIR = path.join(__dirname, 'templates')

// --- templates -----------------------------------------------------------------

let templates
function tpl(name) {
  templates ??= loadTemplates(TEMPLATE_DIR)
  if (!(name in templates)) throw new Error(`Template not found: ${name}`)
  return templates[name]
}

function loadTemplates(dir, prefix = '') {
  const out = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) Object.assign(out, loadTemplates(path.join(dir, entry.name), rel + '/'))
    else out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8')
  }
  return out
}

/** Single pass: values inserted are never re-scanned, so user {{Param}} references stay intact */
function fill(name, vars) {
  return tpl(name).replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Template ${name}: no value for {{${key}}}`)
    return vars[key]
  })
}

// --- escaping ------------------------------------------------------------------

const escText = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => escText(s).replace(/"/g, '&quot;')
/** <value>…</value>, or <value/> when empty — as the CPI editor writes it */
const val = (v) => (v == null || v === '' ? '<value/>' : `<value>${escText(v)}</value>`)

/** java.util.Properties.store() escaping */
function propEscape(s, isKey = false) {
  let out = ''
  for (const [i, ch] of [...String(s ?? '')].entries()) {
    const code = ch.codePointAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\f') out += '\\f'
    else if ('=:#!'.includes(ch)) out += '\\' + ch
    else if (ch === ' ' && (isKey || i === 0)) out += '\\ '
    else if (code < 0x20 || code > 0x7e) out += ch.split('').map((c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
    else out += ch
  }
  return out
}

/** Date in java.util.Date#toString() format, e.g. "Sat Oct 10 13:05:46 UTC 2026" */
function javaDate(d) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`
}

/**
 * One MANIFEST.MF header, folded at 72 bytes with CRLF + space continuation lines. A fold never splits
 * a UTF-8 character, and a line break in the value cannot start a header of its own.
 */
function manifestHeader(name, value) {
  const bytes = Buffer.from(`${name}: ${String(value).replace(/[\r\n]+/g, ' ')}`, 'utf8')
  const lines = []
  for (let i = 0, max = 72; i < bytes.length; max = 71) {
    let end = Math.min(i + max, bytes.length)
    while (end < bytes.length && end > i + 1 && (bytes[end] & 0xc0) === 0x80) end-- // back off to a character start
    lines.push((lines.length ? ' ' : '') + bytes.subarray(i, end).toString('utf8'))
    i = end
  }
  return lines.join('\r\n') + '\r\n'
}

// --- adapter mapping -------------------------------------------------------------

// parameters.propdef references of receiver fields given as {{Param}}: { field: { attributeId, uilabel, categorySuffix } }
const RECEIVER_ATTRIBUTES = () => JSON.parse(tpl('propdef-receiver-attributes.json'))

function splitUrl(url, params = {}) {
  const param = String(url).match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
  // a parameter URL: the query of its default goes to the Query field, the address stays the parameter
  if (param) return { address: url, query: (Object.hasOwn(params || {}, param) && splitParameters(params, [param]).queries[param]) || '' }
  const i = url.indexOf('?')
  return i < 0 ? { address: url, query: '' } : { address: url.slice(0, i), query: url.slice(i + 1) }
}

/** Parameters used as the whole URL of an HTTP receiver ({{P}}) */
function receiverParams(spec) {
  const calls = [...specSteps.mainSteps(spec).map((x) => x.step).filter((s) => s?.type === 'requestReplyHttp'), ...(spec?.end?.type === 'httpReceiver' ? [spec.end] : [])]
  return calls.map((c) => String(c.url ?? '').match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]).filter(Boolean)
}

/**
 * Parameter defaults with a query (https://host/Products?$format=json): CPI keeps the query of a
 * receiver URL in the receiver's Query field (httpAddressQuery), not in the Address, so such a
 * parameter holds the base URL. Only the parameters in `only` (the receiver URLs) are split; any
 * other parameter keeps its value as it is.
 * @returns {{ params: object, queries: Object<string, string> }} defaults (receiver URLs without query), and each query
 */
function splitParameters(parameters = {}, only = null) {
  const params = {}
  const queries = Object.create(null)
  for (const [k, v] of Object.entries(parameters || {})) {
    const s = String(v ?? '')
    const i = (!only || only.includes(k)) && /^https?:\/\//i.test(s) ? s.indexOf('?') : -1
    params[k] = i < 0 ? v : s.slice(0, i)
    if (i >= 0) queries[k] = s.slice(i + 1)
  }
  return { params, queries }
}

// --- layout ----------------------------------------------------------------------

const L = {
  POOL_X: 250,
  POOL_Y: 60,
  POOL_H: 220,
  START_X: 292,
  GAP: 60, // horizontal gap between flow elements
  EVENT: 32,
  TASK_W: 100,
  TASK_H: 60,
  PART_W: 100,
  PART_H: 140,
  SENDER_X: 37,
  RECEIVER_GAP: 80, // pool -> end receiver
  ABOVE_GAP: 60, // request-reply receivers above the pool -> pool
  GATEWAY: 40, // router
  LANE: 100, // main line -> route lanes below it, one per route with steps or an end
  MIN_POOL_W: 400,
  SUB_GAP: 30, // main flow -> exception subprocess below it
  SUB_H: 140,
  SUB_PAD: 40, // subprocess border -> its first/last element
  POOL_PAD: 30 // exception subprocess -> pool bottom
}

const num = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))

/** Indents every line of an XML snippet, so nested elements line up */
const indent = (xml, by = '    ') => xml.replace(/^(?=.)/gm, by)

/** Step node for the flow at index i of `steps` */
const stepNode = (step, name, system) => ({
  kind: 'step',
  step,
  name,
  system,
  prefix: step.type === 'requestReplyHttp' ? 'ServiceTask' : 'CallActivity',
  w: L.TASK_W,
  h: L.TASK_H
})

/** Places nodes left to right on one center line; returns the x after the last node (incl. GAP) */
function layoutRow(nodes, startX, cy) {
  let x = startX
  for (const n of nodes) {
    Object.assign(n, { x, y: cy - n.h / 2 })
    x += n.w + L.GAP
  }
  return x
}

/** Sequence flows between consecutive nodes */
function chain(nodes, nextId) {
  const flows = []
  for (let i = 0; i < nodes.length - 1; i++) {
    const f = { id: nextId('SequenceFlow'), source: nodes[i], target: nodes[i + 1] }
    nodes[i].outgoing = f.id
    nodes[i + 1].incoming = f.id
    flows.push(f)
  }
  return flows
}

// --- build -------------------------------------------------------------------------

/** Copy of the spec with the code of attached scripts filled in (groovyScript steps without code) */
function injectAttachments(spec, attachments = {}) {
  const fillCode = (s) =>
    s?.type === 'groovyScript' && s.code == null && attachments[`${s.fileName}.groovy`] != null
      ? { ...s, code: attachments[`${s.fileName}.groovy`] }
      : s?.type === 'router' && Array.isArray(s.routes)
        ? { ...s, routes: s.routes.map((r) => (Array.isArray(r?.steps) ? { ...r, steps: r.steps.map(fillCode) } : r)) }
        : s
  return {
    ...spec,
    ...(Array.isArray(spec.steps) && { steps: spec.steps.map(fillCode) }),
    ...(spec.exceptionSubprocess && { exceptionSubprocess: { ...spec.exceptionSubprocess, steps: (spec.exceptionSubprocess.steps || []).map(fillCode) } })
  }
}

/**
 * @param {object} spec - iFlow spec v1 (see spec-schema.json)
 * @param {{ now?: Date, attachments?: Object<string, string> }} [options] - attachments: attached
 *   files by name, injected for groovyScript steps without code and for spec.resources
 * @returns {Promise<{ zipBase64: string, files: {path: string, content: string}[], summary: object }>}
 * @throws Error with code INVALID_SPEC and errors[] if the spec is invalid
 */
async function build(spec, { now = new Date(), attachments = {} } = {}) {
  const { valid, errors } = validate(spec, { attachments: Object.keys(attachments) })
  if (!valid) {
    const err = new Error(`Invalid iFlow spec:\n- ${errors.join('\n- ')}`)
    Object.assign(err, { code: 'INVALID_SPEC', status: 400, errors })
    throw err
  }

  const names = effectiveNames(spec)
  let counter = 0
  const nextId = (prefix) => `${prefix}_${++counter}`

  // --- flow graph ------------------------------------------------------------------
  // Nodes in column order: every node gets its own column, so a receiver connector straight up never
  // crosses another step; lanes: 0 is the main line, each route with steps or an end gets a lane below.
  // A router's routes either end (their end event) or stay open: the next main-line element (or the main
  // end) takes up every open route, which is how routes join again.
  const named = new Map(names.flat.map((x) => [x.step, x]))
  const nodes = []
  const flows = []
  const addNode = (n, lane) => {
    Object.assign(n, { id: nextId(n.prefix), lane, col: nodes.length, incoming: [], outgoing: [] })
    nodes.push(n)
    return n
  }
  // target may come later: a route that continues without steps gets its flow now, so the router's routes keep
  // the spec's order (CPI evaluates them in order), and the next main-line element becomes its target
  const connect = (source, target, route) => {
    const f = { id: nextId('SequenceFlow'), source, target, route }
    source.outgoing.push(f.id)
    if (target) target.incoming.push(f.id)
    flows.push(f)
    return f
  }
  const reach = (o, target) => {
    if (o.pending) {
      o.pending.target = target
      target.incoming.push(o.pending.id)
    } else connect(o.node, target, o.route)
  }
  let endCount = 1 // End, End 2, End 3, ... (names given in the spec win)
  const endNode = (end, fallback) => ({
    kind: 'end',
    event: end?.event || 'message',
    category: end?.category || cpiValues.DEFAULT_ESCALATION_CATEGORY, // Escalation End only
    name: end?.name || fallback || `End ${++endCount}`,
    prefix: 'EndEvent',
    w: L.EVENT,
    h: L.EVENT
  })

  const start = addNode({ kind: 'start', prefix: 'StartEvent', w: L.EVENT, h: L.EVENT }, 0)
  if (spec.trigger.type === 'timer') Object.assign(start, { name: 'Start Timer 1', timerId: nextId('TimerEventDefinition'), schedule: cpiValues.scheduleOf(spec.trigger) })
  else start.name = 'Start'

  let open = [{ node: start }] // where the next element connects from (and the route, for a flow that leaves a router)
  let lanes = 0
  const stepOn = (step, lane) => addNode(stepNode(step, named.get(step).name, named.get(step).system), lane)
  for (const step of spec.steps) {
    if (step.type !== 'router') {
      const n = stepOn(step, 0)
      for (const o of open) reach(o, n)
      open = [{ node: n }]
      continue
    }
    const gateway = addNode({ kind: 'router', step, name: named.get(step).name, prefix: 'ExclusiveGateway', w: L.GATEWAY, h: L.GATEWAY }, 0)
    for (const o of open) reach(o, gateway)
    open = []
    for (const route of step.routes) {
      const lane = route.steps?.length || route.end ? ++lanes : 0
      let from = { node: gateway, route: { route, router: step } }
      for (const s of route.steps || []) {
        const n = stepOn(s, lane)
        connect(from.node, n, from.route)
        from = { node: n }
      }
      if (route.end) connect(from.node, addNode(endNode(route.end), lane), from.route)
      else if (from.node === gateway) open.push({ pending: connect(gateway, null, from.route) }) // continues at once: its flow now
      else open.push(from)
    }
  }
  // the main end: none when every route of the last router ends (the validator requires end "none" then)
  const end = open.length ? addNode(endNode(spec.end, 'End'), 0) : null
  for (const o of open) reach(o, end)
  for (const g of nodes.filter((n) => n.kind === 'router')) g.defaultFlow = flows.find((f) => f.source === g && f.route?.route.default)?.id

  // --- layout ------------------------------------------------------------------------
  // receivers of request-reply steps sit above the pool, in their step's column; the end receiver right of it
  const receiversAbove = nodes.some((n) => n.step?.type === 'requestReplyHttp')
  const poolY = L.POOL_Y + (receiversAbove ? L.PART_H + L.ABOVE_GAP : 0)
  const laneCy = (k) => poolY + L.POOL_H / 2 + k * L.LANE
  const cy0 = laneCy(0)
  const colCx = (col) => L.START_X + col * (L.TASK_W + L.GAP) + L.TASK_W / 2
  for (const n of nodes) Object.assign(n, { x: colCx(n.col) - n.w / 2, y: laneCy(n.lane) - n.h / 2 })
  let poolW = Math.max(colCx(nodes.length - 1) + L.TASK_W / 2 + L.GAP - L.POOL_X, L.MIN_POOL_W)
  const lanesBottom = laneCy(lanes) + L.TASK_H / 2
  let poolH = Math.max(L.POOL_H, lanesBottom + L.POOL_PAD - poolY)

  // Exception subprocess: a box inside the pool, below the last lane (error start -> steps -> its end event)
  let sub = null
  if (spec.exceptionSubprocess) {
    sub = { id: nextId('SubProcess'), name: names.exceptionSubprocess, x: L.START_X, y: lanesBottom + L.SUB_GAP, h: L.SUB_H, nodes: [] }
    sub.nodes.push({ id: nextId('StartEvent'), kind: 'errorStart', name: 'Error Start 1', w: L.EVENT, h: L.EVENT })
    spec.exceptionSubprocess.steps.forEach((step, i) => {
      const n = stepNode(step, names.exceptionSteps[i], null)
      sub.nodes.push({ ...n, id: nextId(n.prefix) })
    })
    sub.nodes.push({ ...endNode(spec.exceptionSubprocess.end, 'End 1'), id: nextId('EndEvent') })
    const afterLast = layoutRow(sub.nodes, sub.x + L.SUB_PAD, sub.y + L.SUB_H / 2)
    sub.w = afterLast - L.GAP + L.SUB_PAD - sub.x
    sub.flows = chain(sub.nodes, nextId)
    poolW = Math.max(poolW, sub.x + sub.w + L.SUB_PAD - L.POOL_X)
    poolH = sub.y + sub.h + L.POOL_PAD - poolY
  }

  // Participants + adapters (message flows)
  const participants = []
  const messageFlows = []
  const paramRefs = []
  const adapters = []

  if (spec.trigger.type === 'httpsSender') {
    const p = { id: nextId('Participant'), kind: 'sender', name: 'Sender', x: L.SENDER_X, y: cy0 - L.PART_H / 2 }
    participants.push(p)
    const id = nextId('MessageFlow')
    messageFlows.push({
      id,
      xml: fill('iflw/messageflow-https-sender.xml', {
        ID: id,
        SOURCE: p.id,
        TARGET: start.id,
        ADDRESS_VALUE: val(spec.trigger.address),
        SYSTEM_VALUE: val(p.name)
      }),
      from: [p.x + L.PART_W / 2, cy0],
      to: [start.x + L.EVENT / 2, cy0],
      sourceShape: p.id,
      targetShape: start.id
    })
    adapters.push({ type: 'HTTPS', direction: 'Sender', system: p.name, address: spec.trigger.address })
  }

  const addReceiver = (sourceNode, call, system, placement) => {
    const p = { id: nextId('Participant'), kind: 'receiver', name: system, ...placement }
    participants.push(p)
    const { address, query } = splitUrl(call.url, spec.parameters)
    if (address.includes('?')) throw Object.assign(new Error(`receiver ${system}: the address still contains '?'`), { errors: [`receiver ${system}: the address must not contain '?'; the query belongs in the Query field`] })
    const mf = { id: nextId('MessageFlow'), sourceShape: sourceNode.id, targetShape: p.id }
    const cpiSettings = receiverSettings.toCpi(call) // authentication, proxy, timeout as CPI stores them
    mf.vars = {
      SOURCE: sourceNode.id,
      TARGET: p.id,
      METHOD_VALUE: val(call.method),
      SYSTEM_VALUE: val(system),
      ADDRESS_VALUE: val(address),
      ADDRESS_QUERY_VALUE: val(query),
      AUTH_METHOD_VALUE: val(cpiSettings.authenticationMethod),
      CREDENTIAL_NAME_VALUE: val(cpiSettings.credentialName),
      PROXY_TYPE_VALUE: val(cpiSettings.proxyType),
      LOCATION_ID_VALUE: val(cpiSettings.locationID),
      TIMEOUT_VALUE: val(cpiSettings.httpRequestTimeout)
    }
    messageFlows.push(mf)
    // fields given as a whole {{Param}}: a reference in parameters.propdef, as the CPI editor writes it
    const attributes = RECEIVER_ATTRIBUTES()
    for (const [field, value] of [['address', address], ['credentialName', cpiSettings.credentialName], ['locationID', cpiSettings.locationID]]) {
      const param = String(value).match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
      const a = attributes[field]
      if (param) paramRefs.push({ category: system + a.categorySuffix, attributeId: a.attributeId, uilabel: a.uilabel, key: param })
    }
    adapters.push({ type: 'HTTP', direction: 'Receiver', system, address: call.url, method: call.method, authType: cpiSettings.authenticationMethod })
    return { p, mf }
  }

  // Request-reply receivers sit above the pool in their step's column (a straight connector up that crosses
  // no other step and never the exception subprocess below); the end receiver right of the pool
  for (const n of nodes.filter((n) => n.step?.type === 'requestReplyHttp')) {
    const { p, mf } = addReceiver(n, n.step, n.system, { x: n.x, y: poolY - L.ABOVE_GAP - L.PART_H })
    mf.from = [n.x + L.TASK_W / 2, n.y]
    mf.to = [p.x + L.PART_W / 2, p.y + L.PART_H]
  }
  if (spec.end.type === 'httpReceiver') {
    const { p, mf } = addReceiver(end, spec.end, names.endSystem, { x: L.POOL_X + poolW + L.RECEIVER_GAP, y: cy0 - L.PART_H / 2 })
    mf.from = [end.x + L.EVENT / 2, cy0]
    mf.to = [p.x, cy0]
  }
  for (const mf of messageFlows) if (mf.vars) mf.xml = fill('iflw/messageflow-http-receiver.xml', { ID: mf.id, ...mf.vars })

  // --- XML assembly ----------------------------------------------------------------
  const participantXml = participants
    .map((p) => fill(p.kind === 'sender' ? 'iflw/participant-sender.xml' : 'iflw/participant-receiver.xml', { ID: p.id, NAME: escAttr(p.name) }))
    .join('')

  // a flow that leaves a router is a route: its name, expression type and condition (none on the default route)
  const flowXml_ = (f) => {
    const io = { ID: f.id, SOURCE: f.source.id, TARGET: f.target.id }
    if (!f.route) return fill('iflw/sequence-flow.xml', io)
    const { route, router } = f.route
    const common = { ...io, NAME: escAttr(route.name), EXPRESSION_TYPE_VALUE: val(router.expressionType) }
    return route.default
      ? fill('iflw/route-default.xml', common)
      : fill('iflw/route-condition.xml', { ...common, CONDITION_ID: `FormalExpression_${f.id}`, CONDITION: escText(route.condition) })
  }
  const flowsXml = (list) => list.map(flowXml_).join('')
  const subXml = sub
    ? fill('iflw/subprocess-exception.xml', { ID: sub.id, NAME: escAttr(sub.name), ELEMENTS: indent(sub.nodes.map((n) => nodeToXml(n)).join('') + flowsXml(sub.flows)) })
    : ''
  const nodeXml = nodes.map((n) => nodeToXml(n)).join('') + subXml
  const flowXml = flowsXml(flows)

  const shape = (element, w, h, sx, sy) =>
    fill('iflw/shape.xml', { ELEMENT: element, ID: `BPMNShape_${element}`, WIDTH: num(w), HEIGHT: num(h), X: num(sx), Y: num(sy) })
  const subNodes = sub ? sub.nodes : []
  const shapes =
    nodes.map((n) => shape(n.id, n.w, n.h, n.x, n.y)).join('') +
    (sub ? shape(sub.id, sub.w, sub.h, sub.x, sub.y) + subNodes.map((n) => shape(n.id, n.w, n.h, n.x, n.y)).join('') : '') +
    shape('Participant_Process_1', poolW, poolH, L.POOL_X, poolY) +
    participants.map((p) => shape(p.id, L.PART_W, L.PART_H, p.x, p.y)).join('')

  const edge = (element, source, target, points) =>
    fill('iflw/edge.xml', {
      ELEMENT: element,
      ID: `BPMNEdge_${element}`,
      SOURCE: `BPMNShape_${source}`,
      TARGET: `BPMNShape_${target}`,
      WAYPOINTS: points.map(([px, py]) => fill('iflw/waypoint.xml', { X: num(px), Y: num(py) })).join('')
    })
  const center = (n) => [n.x + n.w / 2, n.y + n.h / 2]
  // straight within a lane; down into a route lane at the source's column, back up at the target's column
  const waypoints = ({ source, target }) => {
    const [a, b] = [center(source), center(target)]
    if (a[1] === b[1]) return [a, b]
    return b[1] > a[1] ? [a, [a[0], b[1]], b] : [a, [b[0], a[1]], b]
  }
  const edges =
    [...flows, ...(sub ? sub.flows : [])].map((f) => edge(f.id, f.source.id, f.target.id, waypoints(f))).join('') +
    messageFlows.map((mf) => edge(mf.id, mf.sourceShape, mf.targetShape, [mf.from, mf.to])).join('')

  const iflw = fill('iflw/definitions.xml', {
    PARTICIPANTS: participantXml,
    MESSAGE_FLOWS: messageFlows.map((mf) => mf.xml).join(''),
    PROCESS_ELEMENTS: nodeXml,
    SEQUENCE_FLOWS: flowXml,
    SHAPES: shapes,
    EDGES: edges
  })

  // --- bundle files ------------------------------------------------------------------
  const date = javaDate(now)
  const { params } = splitParameters(spec.parameters, receiverParams(spec)) // receiver URLs without their query (it is in the Query field)
  const paramNames = Object.keys(params)

  const files = []
  const add = (p, content) => files.push({ path: p, content })

  add(`src/main/resources/scenarioflows/integrationflow/${spec.id}.iflw`, iflw)
  const withCode = injectAttachments(spec, attachments)
  for (const s of specSteps.allSteps(withCode).map((x) => x.step).filter((s) => s.type === 'groovyScript'))
    add(`src/main/resources/script/${s.fileName}.groovy`, s.code)
  for (const r of spec.resources || []) add(`src/main/resources/mapping/${r}`, attachments[r])
  add(
    'src/main/resources/parameters.prop',
    `#${date}\n` + [...paramNames].sort().map((k) => `${propEscape(k, true)}=${propEscape(params[k])}\n`).join('')
  )
  add(
    'src/main/resources/parameters.propdef',
    fill('parameters.propdef', {
      PARAMETERS: paramNames.map((n) => fill('propdef-parameter.xml', { NAME: escText(n) })).join(''),
      PARAM_REFERENCES: paramRefs.length
        ? '<param_references>' +
          paramRefs
            .map((r) => fill('propdef-reference.xml', { CATEGORY: escAttr(r.category), ATTRIBUTE_ID: escAttr(r.attributeId), UILABEL: r.uilabel, PARAM_KEY: escAttr(r.key) }))
            .join('') +
          '</param_references>'
        : '<param_references/>'
    })
  )
  add('.project', fill('project.xml', { NAME: escText(spec.id) }))
  add(
    'META-INF/MANIFEST.MF',
    fill('MANIFEST.MF', {
      BUNDLE_NAME: manifestHeader('Bundle-Name', spec.name),
      BUNDLE_SYMBOLIC_NAME: manifestHeader('Bundle-SymbolicName', `${spec.id}; singleton:=true`),
      ORIGIN_BUNDLE_NAME: manifestHeader('Origin-Bundle-Name', spec.name),
      ORIGIN_BUNDLE_SYMBOLIC_NAME: manifestHeader('Origin-Bundle-SymbolicName', spec.id)
    })
  )
  add('metainfo.prop', fill('metainfo.prop', { DATE: date, DESCRIPTION: propEscape(spec.description || '') }))

  // Zip root holds META-INF/, src/, metainfo.prop, .project — no wrapper folder, no folder entries
  const zip = new JSZip()
  for (const f of files) zip.file(f.path, f.content, { createFolders: false, date: now })
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

  const summary = {
    id: spec.id,
    name: spec.name,
    packageId: spec.packageId,
    trigger:
      spec.trigger.type === 'httpsSender'
        ? { type: 'httpsSender', address: spec.trigger.address }
        : { type: 'timer', mode: spec.trigger.mode, ...(spec.trigger.mode === 'every' && { minutes: spec.trigger.minutes }) },
    steps: nodes.filter((n) => n.kind === 'step' || n.kind === 'router').map((n) => ({ id: n.id, type: n.step.type, name: n.name, ...(n.lane && { route: true }) })),
    end: spec.end.type === 'httpReceiver' ? { type: 'httpReceiver', system: names.endSystem, url: spec.end.url } : { type: 'none' },
    exceptionSubprocess: sub
      ? { id: sub.id, name: sub.name, steps: subNodes.filter((n) => n.kind === 'step').map((n) => ({ id: n.id, type: n.step.type, name: n.name })) }
      : null,
    adapters,
    parameters: paramNames,
    scripts: files.filter((f) => f.path.includes('/script/')).map((f) => f.path),
    sizeBytes: buffer.length
  }

  return { zipBase64: buffer.toString('base64'), files, summary }
}

// End event templates by event: Message End completes the message, Escalation End escalates it, Error End fails it
const END_TEMPLATES = { message: 'iflw/end-message.xml', escalation: 'iflw/end-escalation.xml', error: 'iflw/end-error.xml' }

/**
 * Flow ids for a template's single <bpmn2:incoming>/<bpmn2:outgoing> line: a join step has several incoming
 * flows, a router several outgoing ones (one element per flow, as CPI writes them)
 */
const multi = (ids, tag) => [].concat(ids).join(`</bpmn2:${tag}>\n            <bpmn2:${tag}>`)

function nodeToXml(n) {
  const common = { ID: n.id, NAME: escAttr(n.name) }
  const incoming = multi(n.incoming, 'incoming')
  const outgoing = multi(n.outgoing, 'outgoing')
  if (n.kind === 'start')
    return n.timerId
      ? fill('iflw/start-timer.xml', { ...common, OUTGOING: outgoing, TIMER_ID: n.timerId, SCHEDULE: n.schedule })
      : fill('iflw/start-message.xml', { ...common, OUTGOING: outgoing })
  if (n.kind === 'errorStart') return fill('iflw/start-error.xml', { ...common, OUTGOING: outgoing })
  if (n.kind === 'end') return fill(END_TEMPLATES[n.event || 'message'], { ...common, INCOMING: incoming, CATEGORY_VALUE: val(n.category || 'Others') })
  if (n.kind === 'router') return fill('iflw/router.xml', { ...common, DEFAULT: n.defaultFlow, INCOMING: incoming, OUTGOING: outgoing })

  const io = { ...common, INCOMING: incoming, OUTGOING: outgoing }
  const s = n.step
  switch (s.type) {
    case 'contentModifier': {
      const table = (entries = []) =>
        entries
          .map((e) =>
            // a plain value is a constant, also if a spec says expression (see normalizeTypes); the variable
            // sources have other names in CPI; XPath needs a data type
            fill('content-modifier-row.xml', {
              TYPE: escText(cpiValues.CM_SOURCE_TYPES[e.type === 'expression' && !String(e.value ?? '').includes('${') ? 'constant' : e.type]),
              VALUE: escText(e.value),
              NAME: escText(e.name),
              DEFAULT: escText(e.default || ''),
              DATATYPE: escText(e.datatype || (e.type === 'xpath' ? cpiValues.DEFAULT_XPATH_DATATYPE : ''))
            })
          )
          .join('')
      const hasBody = s.body != null && s.body !== ''
      return fill('iflw/step-content-modifier.xml', {
        ...io,
        // 'expression' only for a body with ${...}, else 'constant' (as Ref_Variables; the CPI editor warns about an
        // expression without parameters); an empty constant body keeps the message body
        BODY_TYPE_VALUE: val(hasBody && String(s.body).includes('${') ? 'expression' : 'constant'),
        BODY_VALUE: val(hasBody ? s.body : ''),
        HEADER_TABLE_VALUE: val(table(s.headers)),
        PROPERTY_TABLE_VALUE: val(table(s.properties))
      })
    }
    case 'groovyScript':
      return fill('iflw/step-groovy-script.xml', { ...io, SCRIPT_VALUE: val(`${s.fileName}.groovy`) })
    case 'writeVariables': {
      const rows = s.variables
        .map((v) =>
          fill('write-variables-row.xml', {
            NAME: escText(v.name),
            DATATYPE: escText(v.datatype || (v.type === 'xpath' ? cpiValues.DEFAULT_XPATH_DATATYPE : '')),
            TYPE: escText(v.type),
            VALUE: escText(v.value),
            SCOPE: cpiValues.scopeOf(v)
          })
        )
        .join('')
      return fill('iflw/step-write-variables.xml', { ...io, VARIABLES_VALUE: val(rows) })
    }
    case 'jsonToXml':
      return fill('iflw/step-json-to-xml.xml', io)
    case 'xmlToJson':
      return fill('iflw/step-xml-to-json.xml', io)
    case 'requestReplyHttp':
      return fill('iflw/step-request-reply.xml', io)
    default:
      throw new Error(`Unsupported step type ${s.type}`) // unreachable after validation
  }
}

module.exports = { build, injectAttachments, splitParameters, receiverParams, javaDate, propEscape, manifestHeader }
