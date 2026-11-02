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
const { validate, effectiveNames, RECEIVER_STEPS } = require('./validator')
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
  const calls = [
    ...[...specSteps.mainSteps(spec), ...specSteps.localSteps(spec)].map((x) => x.step).filter((s) => s?.type === 'requestReplyHttp'),
    ...(spec?.end?.type === 'httpReceiver' ? [spec.end] : [])
  ]
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
  GATEWAY: 40, // router, multicast, join
  LANE: 100, // main line -> route lanes below it, one per route with steps or an end
  MIN_POOL_W: 400,
  SUB_GAP: 30, // main flow -> exception subprocess below it
  SUB_H: 140,
  SUB_PAD: 40, // subprocess border -> its first/last element
  POOL_PAD: 30, // exception subprocess -> pool bottom
  LOCAL_GAP: 60 // pool -> the next local process pool below it (or its receivers)
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
  prefix: RECEIVER_STEPS.includes(step.type) ? 'ServiceTask' : 'CallActivity',
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
  return specSteps.mapSteps(spec, (s) =>
    s?.type === 'groovyScript' && s.code == null && attachments[`${s.fileName}.groovy`] != null ? { ...s, code: attachments[`${s.fileName}.groovy`] } : s
  )
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
  // A line (the main line, or a local process) is drawn the same way. Nodes in column order: every node gets its
  // own column, so a receiver connector straight up (or down) never crosses another step; lanes: 0 is the line
  // itself, each route with steps or an end gets a lane below. A router's routes either end (their end event) or
  // stay open: the next element of the line (or its end) takes up every open route, which is how routes join again.
  // A multicast's branches each get a lane, with their routers' routes in further lanes; the branches meet at its Join.
  const named = new Map([...names.flat, ...names.local].map((x) => [x.step, x]))
  const newLine = () => ({ nodes: [], flows: [], lanes: 0 })
  const addNode = (line, n, lane) => {
    Object.assign(n, { id: nextId(n.prefix), lane, col: line.nodes.length, incoming: [], outgoing: [] })
    line.nodes.push(n)
    return n
  }
  // target may come later: a route that continues without steps gets its flow now, so the router's routes keep
  // the spec's order (CPI evaluates them in order), and the next element of the line becomes its target
  const connect = (line, source, target, route, branch) => {
    const f = { id: nextId('SequenceFlow'), source, target, route, branch }
    source.outgoing.push(f.id)
    if (target) target.incoming.push(f.id)
    line.flows.push(f)
    return f
  }
  const reach = (line, o, target) => {
    if (o.pending) {
      o.pending.target = target
      target.incoming.push(o.pending.id)
    } else connect(line, o.node, target, o.route, o.branch)
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
  // a local process ends with its own plain End (the validator allows only that in its routes)
  const localEnd = (end) => ({ kind: 'localEnd', name: end?.name || `End ${++endCount}`, prefix: 'EndEvent', w: L.EVENT, h: L.EVENT })

  /** Draws start -> steps (routers with their routes) -> the line's end; returns the end node (null when every route of the last router ends) */
  function drawLine(line, steps, start, { routeEnd, lineEnd }) {
    addNode(line, start, 0)
    const stepOn = (step, lane) => addNode(line, stepNode(step, named.get(step).name, named.get(step).system), lane)
    // draws steps on one lane from where they connect (and the route or branch, for a flow that leaves a router or
    // multicast); returns where the next element connects from
    const drawSteps = (list, lane, from_) => {
      let open = from_
      for (const step of list) {
        if (step.type === 'multicast') {
          const multicast = addNode(line, { kind: 'multicast', step, name: named.get(step).name, prefix: 'ParallelGateway', w: L.GATEWAY, h: L.GATEWAY }, lane)
          for (const o of open) reach(line, o, multicast)
          const ends = step.branches.flatMap((branch, j) => drawSteps(branch.steps, ++line.lanes, [{ node: multicast, branch: { name: branch.name || `Branch ${j + 1}` } }]))
          for (const n of line.nodes.slice(multicast.col + 1)) n.inBranch = true
          const join = addNode(line, { kind: 'join', name: names.joins.get(step), prefix: 'ParallelGateway', w: L.GATEWAY, h: L.GATEWAY }, lane)
          for (const o of ends) reach(line, o, join)
          open = [{ node: join }]
          continue
        }
        if (step.type !== 'router') {
          const n = stepOn(step, lane)
          for (const o of open) reach(line, o, n)
          open = [{ node: n }]
          continue
        }
        const gateway = addNode(line, { kind: 'router', step, name: named.get(step).name, prefix: 'ExclusiveGateway', w: L.GATEWAY, h: L.GATEWAY }, lane)
        for (const o of open) reach(line, o, gateway)
        open = []
        for (const route of step.routes) {
          const routeLane = route.steps?.length || route.end ? ++line.lanes : lane
          let from = { node: gateway, route: { route, router: step } }
          for (const s of route.steps || []) {
            const n = stepOn(s, routeLane)
            connect(line, from.node, n, from.route)
            from = { node: n }
          }
          if (route.end) connect(line, from.node, addNode(line, routeEnd(route.end), routeLane), from.route)
          else if (from.node === gateway) open.push({ pending: connect(line, gateway, null, from.route) }) // continues at once: its flow now
          else open.push(from)
        }
      }
      return open
    }
    const open = drawSteps(steps, 0, [{ node: start }])
    const end = open.length ? addNode(line, lineEnd(), 0) : null
    for (const o of open) reach(line, o, end)
    for (const g of line.nodes.filter((n) => n.kind === 'router')) g.defaultFlow = line.flows.find((f) => f.source === g && f.route?.route.default)?.id
    return end
  }

  const start = { kind: 'start', prefix: 'StartEvent', w: L.EVENT, h: L.EVENT, name: spec.trigger.type === 'timer' ? 'Start Timer 1' : 'Start' }
  const mainLine = newLine()
  // the main end: none when every route of the last router ends (the validator requires end "none" then)
  const end = drawLine(mainLine, spec.steps, start, { routeEnd: (e) => endNode(e), lineEnd: () => endNode(spec.end, 'End') })
  if (spec.trigger.type === 'timer') Object.assign(start, { timerId: nextId('TimerEventDefinition'), schedule: cpiValues.scheduleOf(spec.trigger) })
  const { nodes, flows, lanes } = mainLine

  // --- layout ------------------------------------------------------------------------
  // receivers of request-reply steps sit above the pool, in their step's column; the end receiver right of it.
  // In a multicast branch they sit below the pool: a line up would cross the branches above
  const hasReceiver = (n) => RECEIVER_STEPS.includes(n.step?.type)
  const receiversAbove = nodes.some((n) => hasReceiver(n) && !n.inBranch)
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
      const n = stepNode(step, names.exceptionSteps[i], names.exceptionSystems[i])
      sub.nodes.push({ ...n, id: nextId(n.prefix) })
    })
    sub.nodes.push({ ...endNode(spec.exceptionSubprocess.end, 'End 1'), id: nextId('EndEvent') })
    const afterLast = layoutRow(sub.nodes, sub.x + L.SUB_PAD, sub.y + L.SUB_H / 2)
    sub.w = afterLast - L.GAP + L.SUB_PAD - sub.x
    sub.flows = chain(sub.nodes, nextId)
    poolW = Math.max(poolW, sub.x + sub.w + L.SUB_PAD - L.POOL_X)
    poolH = sub.y + sub.h + L.POOL_PAD - poolY
  }

  // Local processes: a pool each below the main pool (start -> steps -> end), the receivers of its request-reply
  // steps below it, so none crosses another pool. Their ids come after the main flow's: Process_1 is the main process.
  const locals = (spec.localProcesses || []).map((lp) => {
    const id = nextId('Process')
    return { lp, id, participantId: `Participant_${id}` }
  })
  const processIds = new Map(locals.map((l) => [l.lp.name, l.id])) // a process call refers to the process id
  // the receivers of Send steps in the exception subprocess sit right below the main pool, in their step's column
  const subReceivers = sub ? sub.nodes.filter(hasReceiver) : []
  // the receivers of steps in multicast branches get their own row below that, as the columns of the two can overlap
  const branchReceiverY = poolY + poolH + L.ABOVE_GAP + (subReceivers.length ? L.PART_H + L.ABOVE_GAP : 0)
  const rowsBelow = (subReceivers.length ? 1 : 0) + (nodes.some((n) => hasReceiver(n) && n.inBranch) ? 1 : 0)
  let localY = poolY + poolH + rowsBelow * (L.ABOVE_GAP + L.PART_H) + L.LOCAL_GAP
  for (const l of locals) {
    const k = locals.indexOf(l) + 1
    l.line = newLine()
    drawLine(l.line, l.lp.steps, { kind: 'localStart', name: `Start ${k}`, prefix: 'StartEvent', w: L.EVENT, h: L.EVENT }, { routeEnd: localEnd, lineEnd: () => localEnd() })
    l.nodes = l.line.nodes
    l.flows = l.line.flows
    // the same columns and lanes as the main pool, from the top of this pool
    const cy = (lane) => localY + L.POOL_H / 2 + lane * L.LANE
    for (const n of l.nodes) Object.assign(n, { x: colCx(n.col) - n.w / 2, y: cy(n.lane) - n.h / 2 })
    const h = Math.max(L.POOL_H, cy(l.line.lanes) + L.TASK_H / 2 + L.POOL_PAD - localY)
    Object.assign(l, { x: L.POOL_X, y: localY, w: Math.max(colCx(l.nodes.length - 1) + L.TASK_W / 2 + L.GAP - L.POOL_X, L.MIN_POOL_W), h })
    localY += h + (l.nodes.some(hasReceiver) ? L.ABOVE_GAP + L.PART_H : 0) + L.LOCAL_GAP
  }
  // a process call names its local process by id; a looping one has its loop and condition ids
  for (const n of [...nodes, ...(sub ? sub.nodes : [])].filter((x) => x.step?.type === 'processCall')) {
    n.processId = processIds.get(n.step.process)
    if (n.step.loop) Object.assign(n, { loopId: nextId('StandardLoopCharacteristics'), conditionId: nextId('FormalExpression') })
  }

  // Participants + adapters (message flows)
  const participants = []
  const messageFlows = []
  const paramRefs = []
  const adapters = []

  // a sender adapter: its template and the adapter type in the summary
  const SENDERS = { httpsSender: ['iflw/messageflow-https-sender.xml', 'HTTPS'], soapSender: ['iflw/messageflow-soap-sender.xml', 'SOAP'] }
  if (SENDERS[spec.trigger.type]) {
    const [template, type] = SENDERS[spec.trigger.type]
    const p = { id: nextId('Participant'), kind: 'sender', name: 'Sender', x: L.SENDER_X, y: cy0 - L.PART_H / 2 }
    participants.push(p)
    const id = nextId('MessageFlow')
    messageFlows.push({
      id,
      xml: fill(template, {
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
    adapters.push({ type, direction: 'Sender', system: p.name, address: spec.trigger.address })
  }

  // parameter references (parameters.propdef) of the fields given as a whole {{Param}}: [attribute, value]
  const addParamRefs = (system, fields) => {
    const attributes = RECEIVER_ATTRIBUTES()
    for (const [field, value] of fields) {
      const param = String(value).match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
      const a = attributes[field]
      if (param) paramRefs.push({ category: system + a.categorySuffix, attributeId: a.attributeId, uilabel: a.uilabel, key: param })
    }
  }
  const addReceiver = (sourceNode, call, system, placement) => {
    const p = { id: nextId('Participant'), kind: 'receiver', name: system, ...placement }
    participants.push(p)
    if (call.type === 'requestReplySoap' || call.type === 'sendMail') {
      const mf = { id: nextId('MessageFlow'), sourceShape: sourceNode.id, targetShape: p.id }
      const common = { SOURCE: sourceNode.id, TARGET: p.id, SYSTEM_VALUE: val(system), CREDENTIAL_NAME_VALUE: val(call.credentialName) }
      if (call.type === 'requestReplySoap') {
        mf.template = 'iflw/messageflow-soap-receiver.xml'
        mf.vars = { ...common, ADDRESS_VALUE: val(call.url), LOCATION_ID_VALUE: val(call.locationId), TIMEOUT_VALUE: val(String(call.timeout ?? 60000)) }
        addParamRefs(system, [['soapAddress', call.url]])
        adapters.push({ type: 'SOAP', direction: 'Receiver', system, address: call.url, authType: call.authType })
      } else {
        mf.template = 'iflw/messageflow-mail-receiver.xml'
        mf.vars = {
          ...common,
          SERVER_VALUE: val(call.server),
          FROM_VALUE: val(call.from),
          TO_VALUE: val(call.to),
          CC_VALUE: val(call.cc),
          BCC_VALUE: val(call.bcc),
          SUBJECT_VALUE: val(call.subject),
          BODY_VALUE: val(call.body ?? '${in.body}')
        }
        addParamRefs(system, [['mailServer', call.server], ['mailTo', call.to], ['mailCredential', call.credentialName]])
        adapters.push({ type: 'Mail', direction: 'Receiver', system, address: call.server })
      }
      messageFlows.push(mf)
      return { p, mf }
    }
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
    addParamRefs(system, [['address', address], ['credentialName', cpiSettings.credentialName], ['locationID', cpiSettings.locationID]])
    adapters.push({ type: 'HTTP', direction: 'Receiver', system, address: call.url, method: call.method, authType: cpiSettings.authenticationMethod })
    return { p, mf }
  }

  // Request-reply receivers sit above the pool in their step's column (a straight connector up that crosses
  // no other step and never the exception subprocess below); those of multicast branches below it; the end
  // receiver right of the pool
  for (const n of nodes.filter((x) => hasReceiver(x) && x.inBranch)) {
    const { p, mf } = addReceiver(n, n.step, n.system, { x: n.x, y: branchReceiverY })
    mf.from = [n.x + L.TASK_W / 2, n.y + L.TASK_H]
    mf.to = [p.x + L.PART_W / 2, p.y]
  }
  for (const n of nodes.filter((x) => hasReceiver(x) && !x.inBranch)) {
    const { p, mf } = addReceiver(n, n.step, n.system, { x: n.x, y: poolY - L.ABOVE_GAP - L.PART_H })
    mf.from = [n.x + L.TASK_W / 2, n.y]
    mf.to = [p.x + L.PART_W / 2, p.y + L.PART_H]
  }
  for (const l of locals)
    for (const n of l.nodes.filter(hasReceiver)) {
      const { p, mf } = addReceiver(n, n.step, n.system, { x: n.x, y: l.y + l.h + L.ABOVE_GAP })
      mf.from = [n.x + L.TASK_W / 2, n.y + L.TASK_H]
      mf.to = [p.x + L.PART_W / 2, p.y]
    }
  for (const n of subReceivers) {
    const { p, mf } = addReceiver(n, n.step, n.system, { x: n.x, y: poolY + poolH + L.ABOVE_GAP })
    mf.from = [n.x + L.TASK_W / 2, n.y + L.TASK_H]
    mf.to = [p.x + L.PART_W / 2, p.y]
  }
  if (spec.end.type === 'httpReceiver') {
    const { p, mf } = addReceiver(end, spec.end, names.endSystem, { x: L.POOL_X + poolW + L.RECEIVER_GAP, y: cy0 - L.PART_H / 2 })
    mf.from = [end.x + L.EVENT / 2, cy0]
    mf.to = [p.x, cy0]
  }
  for (const mf of messageFlows) if (mf.vars) mf.xml = fill(mf.template || 'iflw/messageflow-http-receiver.xml', { ID: mf.id, ...mf.vars })

  // --- XML assembly ----------------------------------------------------------------
  const participantXml =
    participants.map((p) => fill(p.kind === 'sender' ? 'iflw/participant-sender.xml' : 'iflw/participant-receiver.xml', { ID: p.id, NAME: escAttr(p.name) })).join('') +
    locals.map((l) => fill('iflw/participant-process.xml', { ID: l.participantId, NAME: escAttr(l.lp.name), PROCESS: l.id })).join('')

  // a flow that leaves a router is a route: its name, expression type and condition (none on the default route)
  const flowXml_ = (f) => {
    const io = { ID: f.id, SOURCE: f.source.id, TARGET: f.target.id }
    if (f.branch) return fill('iflw/branch-flow.xml', { ...io, NAME: escAttr(f.branch.name) })
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
  const localXml = locals.map((l) => fill('iflw/process-local.xml', { ID: l.id, NAME: escAttr(l.lp.name), ELEMENTS: l.nodes.map((n) => nodeToXml(n)).join('') + flowsXml(l.flows) })).join('')

  const shape = (element, w, h, sx, sy) =>
    fill('iflw/shape.xml', { ELEMENT: element, ID: `BPMNShape_${element}`, WIDTH: num(w), HEIGHT: num(h), X: num(sx), Y: num(sy) })
  const subNodes = sub ? sub.nodes : []
  const shapes =
    nodes.map((n) => shape(n.id, n.w, n.h, n.x, n.y)).join('') +
    (sub ? shape(sub.id, sub.w, sub.h, sub.x, sub.y) + subNodes.map((n) => shape(n.id, n.w, n.h, n.x, n.y)).join('') : '') +
    shape('Participant_Process_1', poolW, poolH, L.POOL_X, poolY) +
    locals.map((l) => shape(l.participantId, l.w, l.h, l.x, l.y) + l.nodes.map((n) => shape(n.id, n.w, n.h, n.x, n.y)).join('')).join('') +
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
    [...flows, ...(sub ? sub.flows : []), ...locals.flatMap((l) => l.flows)].map((f) => edge(f.id, f.source.id, f.target.id, waypoints(f))).join('') +
    messageFlows.map((mf) => edge(mf.id, mf.sourceShape, mf.targetShape, [mf.from, mf.to])).join('')

  const iflw = fill('iflw/definitions.xml', {
    PARTICIPANTS: participantXml,
    MESSAGE_FLOWS: messageFlows.map((mf) => mf.xml).join(''),
    PROCESS_ELEMENTS: nodeXml,
    SEQUENCE_FLOWS: flowXml,
    LOCAL_PROCESSES: localXml,
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
  // mapping files: of the steps and in spec.resources, each once (steps may share a file or a schema)
  const mappingFiles = new Map((spec.resources || []).map((r) => [`src/main/resources/mapping/${r}`, attachments[r]]))
  for (const { step: s } of specSteps.allSteps(spec)) {
    if (s.type === 'xsltMapping' || (s.type === 'messageMapping' && s.file)) mappingFiles.set(`src/main/resources/mapping/${s.file}`, attachments[s.file])
    for (const f of (s.type === 'messageMapping' && s.schemas) || []) mappingFiles.set(`src/main/resources/${/\.wsdl$/i.test(f) ? 'wsdl' : 'xsd'}/${f}`, attachments[f])
  }
  for (const [p, content] of mappingFiles) add(p, content)
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
      SENDERS[spec.trigger.type]
        ? { type: spec.trigger.type, address: spec.trigger.address }
        : { type: 'timer', mode: spec.trigger.mode, ...(spec.trigger.mode === 'every' && { minutes: spec.trigger.minutes }) },
    steps: nodes.filter((n) => ['step', 'router', 'multicast'].includes(n.kind)).map((n) => ({ id: n.id, type: n.step.type, name: n.name, ...(n.lane && { route: true }) })),
    end: spec.end.type === 'httpReceiver' ? { type: 'httpReceiver', system: names.endSystem, url: spec.end.url } : { type: 'none' },
    exceptionSubprocess: sub
      ? { id: sub.id, name: sub.name, steps: subNodes.filter((n) => n.kind === 'step').map((n) => ({ id: n.id, type: n.step.type, name: n.name })) }
      : null,
    localProcesses: locals.map((l) => ({ id: l.id, name: l.lp.name, steps: l.nodes.filter((n) => n.kind === 'step').map((n) => ({ id: n.id, type: n.step.type, name: n.name })) })),
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
  if (n.kind === 'localStart') return fill('iflw/start-local.xml', { ...common, OUTGOING: outgoing })
  if (n.kind === 'localEnd') return fill('iflw/end-local.xml', { ...common, INCOMING: incoming })
  if (n.kind === 'end') return fill(END_TEMPLATES[n.event || 'message'], { ...common, INCOMING: incoming, CATEGORY_VALUE: val(n.category || 'Others') })
  if (n.kind === 'router') return fill('iflw/router.xml', { ...common, DEFAULT: n.defaultFlow, INCOMING: incoming, OUTGOING: outgoing })
  if (n.kind === 'join') return fill('iflw/join.xml', { ...common, INCOMING: incoming, OUTGOING: outgoing })
  if (n.kind === 'multicast')
    return n.step.mode === 'sequential'
      ? fill('iflw/multicast-sequential.xml', { ...common, INCOMING: incoming, OUTGOING: outgoing, ROUTING_SEQUENCE_VALUE: val(n.outgoing.map((id, i) => `<row><cell>${i + 1}</cell><cell>${id}</cell></row>`).join('')) })
      : fill('iflw/multicast-parallel.xml', { ...common, INCOMING: incoming, OUTGOING: outgoing })

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
    case 'requestReplySoap':
      return fill('iflw/step-request-reply.xml', io)
    case 'sendMail':
      return fill('iflw/step-send.xml', io)
    case 'messageMapping': {
      // an artifact has its bundle id; a mapping inside the iFlow has its file. The same path and uri either way
      const base = s.mapping || s.file.replace(/\.mmap$/, '')
      return fill('iflw/step-message-mapping.xml', {
        ...io,
        MAPPING_NAME_VALUE: val(base),
        MAPPING_PATH_VALUE: val(`src/main/resources/mapping/${base}`),
        MAPPING_URI_VALUE: val(`dir://mmap/src/main/resources/mapping/${base}.mmap`),
        BUNDLE_ID_VALUE: val(s.mapping)
      })
    }
    case 'xsltMapping': {
      const base = s.file.replace(/\.xslt?$/, '')
      return fill('iflw/step-xslt-mapping.xml', {
        ...io,
        MAPPING_NAME_VALUE: val(base),
        MAPPING_PATH_VALUE: val(`src/main/resources/mapping/${base}`),
        MAPPING_URI_VALUE: val(`dir://mapping/xslt/src/main/resources/mapping/${s.file}`)
      })
    }
    case 'splitter': {
      // the item XPath also goes to the Iterating Splitter's token value, as the CPI editor writes it
      const expression = val(s.expression)
      return fill(`iflw/step-splitter-${s.kind}.xml`, {
        ...io,
        EXPRESSION_VALUE: expression,
        GROUPING_VALUE: val(String(s.grouping ?? 1)),
        STREAMING_VALUE: val(String(s.streaming ?? true)),
        STOP_ON_EXCEPTION_VALUE: val(String(s.stopOnException)),
        ...(s.kind === 'iterating' && { TOKEN_VALUE: expression })
      })
    }
    case 'gather':
      return fill('iflw/step-gather.xml', { ...io, ALGORITHM_VALUE: val(cpiValues.gatherAlgorithm(s)), SOURCE_VALUE: val(s.source), TARGET_VALUE: val(s.target) })
    case 'processCall':
      return s.loop
        ? fill('iflw/step-process-call-looping.xml', {
            ...io,
            PROCESS_ID_VALUE: val(n.processId),
            LOOP_ID_VALUE: val(n.loopId),
            LOOP_ID: n.loopId,
            MAX: String(s.loop.max),
            CONDITION_ID: n.conditionId,
            CONDITION: escText(s.loop.condition)
          })
        : fill('iflw/step-process-call.xml', { ...io, PROCESS_ID_VALUE: val(n.processId) })
    default:
      throw new Error(`Unsupported step type ${s.type}`) // unreachable after validation
  }
}

module.exports = { build, injectAttachments, splitParameters, receiverParams, javaDate, propEscape, manifestHeader }
