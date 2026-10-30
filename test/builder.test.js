const { build, javaDate, propEscape, manifestHeader } = require('../srv/iflow-builder/builder')
const sample = require('../srv/iflow-builder/samples/Pilot_Test_1.json')
const { baseSpec, GROOVY, unzip, parseXml, all, propList } = require('./helpers')

const NOW = new Date('2026-10-10T13:05:46Z')

/** Builds and returns the parsed iflw plus raw files */
async function built(spec) {
  const result = await build(spec, { now: NOW })
  const files = await unzip(result.zipBase64)
  const iflw = files[`src/main/resources/scenarioflows/integrationflow/${spec.id}.iflw`]
  return { result, files, iflw, doc: parseXml(iflw) }
}

const byId = (doc, id) => [...doc.getElementsByTagName('*')].find((e) => e.getAttribute('id') === id)
const props = (el) => Object.fromEntries(propList(el))

/** Structural invariants every generated iFlow must satisfy */
function assertStructure(doc) {
  // unique ids
  const ids = [...doc.getElementsByTagName('*')].map((e) => e.getAttribute('id')).filter(Boolean)
  expect(new Set(ids).size).toBe(ids.length)

  // linear sequence: start -> ... -> end, incoming/outgoing consistent with sequenceFlows
  const flows = all(doc, 'sequenceFlow')
  const start = all(doc, 'startEvent')[0]
  const end = all(doc, 'endEvent')[0]
  let current = start
  const visited = [start]
  for (let i = 0; i < flows.length; i++) {
    const f = flows.find((x) => x.getAttribute('sourceRef') === current.getAttribute('id'))
    expect(f).toBeDefined()
    const outgoing = all(current, 'outgoing').map((o) => o.textContent)
    expect(outgoing).toEqual([f.getAttribute('id')])
    current = byId(doc, f.getAttribute('targetRef'))
    expect(all(current, 'incoming').map((o) => o.textContent)).toEqual([f.getAttribute('id')])
    visited.push(current)
  }
  expect(current).toBe(end)
  expect(all(doc, 'process')[0].childNodes.length).toBeGreaterThan(0)

  // every flow element, participant and flow has diagram info pointing to existing elements
  const shapes = all(doc, 'BPMNShape')
  const edges = all(doc, 'BPMNEdge')
  for (const el of [...visited, ...all(doc, 'participant')]) expect(shapes.some((s) => s.getAttribute('bpmnElement') === el.getAttribute('id'))).toBe(true)
  for (const f of [...flows, ...all(doc, 'messageFlow')]) expect(edges.some((e) => e.getAttribute('bpmnElement') === f.getAttribute('id'))).toBe(true)
  for (const e of edges) {
    expect(byId(doc, e.getAttribute('sourceElement'))).toBeDefined()
    expect(byId(doc, e.getAttribute('targetElement'))).toBeDefined()
  }

  // message flows reference existing participants / flow nodes
  for (const mf of all(doc, 'messageFlow')) {
    expect(byId(doc, mf.getAttribute('sourceRef'))).toBeDefined()
    expect(byId(doc, mf.getAttribute('targetRef'))).toBeDefined()
  }

  // layout: flow nodes inside the pool, nothing overlaps
  const box = (s) => {
    const b = all(s, 'Bounds')[0]
    return { id: s.getAttribute('bpmnElement'), x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height') }
  }
  const boxes = shapes.map(box)
  const pool = boxes.find((b) => b.id === 'Participant_Process_1')
  const others = boxes.filter((b) => b !== pool)
  const nodeIds = new Set(visited.map((n) => n.getAttribute('id')))
  for (const b of others.filter((b) => nodeIds.has(b.id))) {
    expect(b.x).toBeGreaterThanOrEqual(pool.x)
    expect(b.x + b.w).toBeLessThanOrEqual(pool.x + pool.w)
    expect(b.y).toBeGreaterThanOrEqual(pool.y)
    expect(b.y + b.h).toBeLessThanOrEqual(pool.y + pool.h)
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) expect(overlap(others[i], others[j])).toBe(false)
  // participants (sender/receivers) do not overlap the pool
  for (const b of others.filter((b) => !nodeIds.has(b.id))) expect(overlap(b, pool)).toBe(false)
}

const stepElement = (doc, name) => [...all(doc, 'callActivity'), ...all(doc, 'serviceTask')].find((e) => e.getAttribute('name') === name)

describe('builder', () => {
  test('zip root contains META-INF/, src/, metainfo.prop, .project and no wrapper folder or folder entries', async () => {
    const { result, files } = await built(sample)
    const names = Object.keys(files)
    expect(names.sort()).toEqual(
      [
        '.project',
        'META-INF/MANIFEST.MF',
        'metainfo.prop',
        'src/main/resources/parameters.prop',
        'src/main/resources/parameters.propdef',
        'src/main/resources/scenarioflows/integrationflow/Pilot_Test_1.iflw',
        'src/main/resources/script/addLengthHeader.groovy'
      ].sort()
    )
    expect(Object.values(files).every((c) => c !== null)).toBe(true)
    expect(result.files.map((f) => f.path).sort()).toEqual(names.sort())
    expect(result.summary).toMatchObject({ id: 'Pilot_Test_1', steps: [{ type: 'contentModifier' }, { type: 'groovyScript' }], end: { type: 'httpReceiver' } })
  })

  test('MANIFEST.MF carries id and name; .project the id', async () => {
    const spec = baseSpec({ id: 'My_Flow', name: 'My Flow With A Rather Long Display Name That Needs Folding In The Manifest' })
    const { files } = await built(spec)
    const mf = files['META-INF/MANIFEST.MF']
    expect(mf).toContain('Bundle-SymbolicName: My_Flow; singleton:=true\r\n')
    expect(mf.split('\r\n').every((l) => Buffer.byteLength(l) <= 72)).toBe(true)
    expect(mf.replace(/\r\n /g, '')).toContain(`Bundle-Name: ${spec.name}\r\n`)
    expect(files['.project']).toContain('<name>My_Flow</name>')
  })

  test('httpsSender trigger: sender participant + HTTPS message flow with the address', async () => {
    const { doc } = await built(baseSpec())
    assertStructure(doc)
    const [mf] = all(doc, 'messageFlow')
    const p = props(mf)
    expect(p).toMatchObject({ ComponentType: 'HTTPS', urlPath: '/test/flow', system: 'Sender', cmdVariantUri: expect.stringContaining('cname::sap:HTTPS') })
    expect(byId(doc, mf.getAttribute('sourceRef')).getAttribute('ifl:type')).toBe('EndpointSender')
    expect(mf.getAttribute('targetRef')).toBe(all(doc, 'startEvent')[0].getAttribute('id'))
  })

  test('timer trigger: run-once timer start event, no sender participant', async () => {
    const { doc } = await built(baseSpec({ trigger: { type: 'timer', mode: 'once' } }))
    assertStructure(doc)
    const start = all(doc, 'startEvent')[0]
    const timer = all(start, 'timerEventDefinition')[0]
    expect(timer).toBeDefined()
    expect(props(timer)).toMatchObject({ activityType: 'StartTimerEvent', scheduleKey: expect.stringContaining('simple.repeat=NONE') })
    expect(all(doc, 'participant')).toHaveLength(1) // only the integration process
    expect(all(doc, 'messageFlow')).toHaveLength(0)
  })

  test('body type: constant for a plain body, expression only when it contains ${...}; rows likewise', async () => {
    const cm = (body, rows) => built(baseSpec({ steps: [{ type: 'contentModifier', body, properties: rows }] })).then(({ doc }) => props(stepElement(doc, 'Content Modifier 1')))
    expect(await cm('<root><value>42</value></root>')).toMatchObject({ bodyType: 'constant', wrapContent: '<root><value>42</value></root>' })
    expect(await cm('{"id": "${property.orderId}"}')).toMatchObject({ bodyType: 'expression' })
    const rows = await cm(undefined, [
      { name: 'Plain', type: 'expression', value: 'SF' },
      { name: 'Expr', type: 'expression', value: '${header.Source}' }
    ])
    expect(rows.bodyType).toBe('constant')
    expect(rows.propertyTable).toContain("<cell id='Type'>constant</cell><cell id='Value'>SF</cell>")
    expect(rows.propertyTable).toContain("<cell id='Type'>expression</cell><cell id='Value'>${header.Source}</cell>")
  })

  test('contentModifier: headers, properties and body', async () => {
    const step = {
      type: 'contentModifier',
      headers: [
        { name: 'A', type: 'constant', value: 'x<y & z' },
        { name: 'B', type: 'expression', value: '${property.p}', datatype: 'java.lang.String' }
      ],
      properties: [{ name: 'P', type: 'constant', value: '1' }],
      body: '<root/>'
    }
    const { doc } = await built(baseSpec({ steps: [step] }))
    assertStructure(doc)
    const p = props(stepElement(doc, 'Content Modifier 1'))
    // a plain body is a constant (the CPI editor warns about an expression without parameters)
    expect(p).toMatchObject({ activityType: 'Enricher', bodyType: 'constant', wrapContent: '<root/>' })
    expect(p.headerTable).toBe(
      "<row><cell id='Action'>Create</cell><cell id='Type'>constant</cell><cell id='Value'>x&lt;y &amp; z</cell><cell id='Default'></cell><cell id='Name'>A</cell><cell id='Datatype'></cell></row>" +
        "<row><cell id='Action'>Create</cell><cell id='Type'>expression</cell><cell id='Value'>${property.p}</cell><cell id='Default'></cell><cell id='Name'>B</cell><cell id='Datatype'>java.lang.String</cell></row>"
    )
    expect(p.propertyTable).toContain("<cell id='Name'>P</cell>")
  })

  test('contentModifier without body keeps the body (constant + empty, as in the reference)', async () => {
    const { doc } = await built(baseSpec({ steps: [{ type: 'contentModifier' }] }))
    expect(props(stepElement(doc, 'Content Modifier 1'))).toMatchObject({ bodyType: 'constant', wrapContent: '', headerTable: '', propertyTable: '' })
  })

  test('groovyScript: script reference and file in script/', async () => {
    const { doc, files } = await built(baseSpec({ steps: [{ type: 'groovyScript', fileName: 'setHeaders', code: GROOVY }] }))
    assertStructure(doc)
    expect(props(stepElement(doc, 'Groovy Script 1'))).toMatchObject({ activityType: 'Script', subActivityType: 'GroovyScript', script: 'setHeaders.groovy' })
    expect(files['src/main/resources/script/setHeaders.groovy']).toBe(GROOVY)
  })

  test.each([
    ['jsonToXml', 'JSON to XML Converter 1', 'JsonToXmlConverter'],
    ['xmlToJson', 'XML to JSON Converter 1', 'XmlToJsonConverter']
  ])('%s converter step', async (type, name, activityType) => {
    const { doc } = await built(baseSpec({ steps: [{ type }] }))
    assertStructure(doc)
    expect(props(stepElement(doc, name))).toMatchObject({ activityType })
  })

  test('requestReplyHttp: service task + receiver participant + HTTP adapter', async () => {
    const steps = [
      { type: 'requestReplyHttp', url: 'https://api.example.org/v1/items?top=5', method: 'GET', authType: 'None' },
      { type: 'requestReplyHttp', system: 'Backend', url: '{{BackendURL}}', method: 'POST', authType: 'None' }
    ]
    const { doc, files } = await built(baseSpec({ steps, parameters: { BackendURL: 'https://backend.example.org' } }))
    assertStructure(doc)
    const tasks = all(doc, 'serviceTask')
    expect(tasks).toHaveLength(2)
    expect(props(tasks[0])).toMatchObject({ activityType: 'ExternalCall' })
    const flows = all(doc, 'messageFlow').filter((f) => props(f).direction === 'Receiver')
    expect(flows.map((f) => f.getAttribute('sourceRef'))).toEqual(tasks.map((t) => t.getAttribute('id')))
    expect(props(flows[0])).toMatchObject({ ComponentType: 'HTTP', system: 'Receiver1', httpMethod: 'GET', httpAddressWithoutQuery: 'https://api.example.org/v1/items', httpAddressQuery: 'top=5', authenticationMethod: 'None', credentialName: '' })
    expect(props(flows[1])).toMatchObject({ system: 'Backend', httpMethod: 'POST', httpAddressWithoutQuery: '{{BackendURL}}', authenticationMethod: 'None', credentialName: '' })
    for (const f of flows) expect(byId(doc, f.getAttribute('targetRef')).getAttribute('ifl:type')).toBe('EndpointRecevier')
    expect(files['src/main/resources/parameters.propdef']).toContain('attribute_category="Backend"')
  })

  test('httpReceiver end: message flow from the end event', async () => {
    const { doc } = await built(baseSpec({ end: { type: 'httpReceiver', url: 'https://x.org/in', method: 'PUT', authType: 'None' } }))
    assertStructure(doc)
    const [mf] = all(doc, 'messageFlow').filter((f) => props(f).direction === 'Receiver')
    expect(mf.getAttribute('sourceRef')).toBe(all(doc, 'endEvent')[0].getAttribute('id'))
    expect(props(mf)).toMatchObject({ system: 'Receiver', httpMethod: 'PUT', httpAddressWithoutQuery: 'https://x.org/in' })
  })

  test('long flows widen the pool and keep receivers clear', async () => {
    const steps = Array.from({ length: 12 }, (_, i) =>
      i % 3 === 2 ? { type: 'requestReplyHttp', url: `https://x.org/${i}`, method: 'GET', authType: 'None' } : { type: i % 2 ? 'jsonToXml' : 'xmlToJson' }
    )
    const { doc } = await built(baseSpec({ steps, end: { type: 'httpReceiver', url: 'https://y.org', method: 'POST', authType: 'None' } }))
    assertStructure(doc)
  })

  test('externalized parameters go to parameters.prop and parameters.propdef', async () => {
    const { files } = await built(sample)
    expect(files['src/main/resources/parameters.prop']).toBe('#Sat Oct 10 13:05:46 UTC 2026\nReceiverURL=https\\://httpbin.org/post\n')
    const propdef = files['src/main/resources/parameters.propdef']
    expect(propdef).toContain('<name>ReceiverURL</name>')
    expect(propdef).toContain(
      '<reference attribute_category="Receiver" attribute_id="ctype::AdapterVariant/cname::HTTP/tp::HTTP/mp::None/direction::Receiver/version::1.22.0/attrId::httpAddressWithoutQuery" attribute_uilabel="Address" param_key="ReceiverURL"/>'
    )
  })

  test('without parameters: empty prop file and empty param_references', async () => {
    const { files } = await built(baseSpec())
    expect(files['src/main/resources/parameters.prop']).toBe('#Sat Oct 10 13:05:46 UTC 2026\n')
    expect(files['src/main/resources/parameters.propdef']).toBe('<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters><param_references/></parameters>')
  })

  test('throws INVALID_SPEC with readable errors', async () => {
    await expect(build(baseSpec({ steps: [{ type: 'parallelMulticast' }] }))).rejects.toMatchObject({ code: 'INVALID_SPEC', errors: [expect.stringContaining("'parallelMulticast' is not supported yet")] })
  })

  test('helpers: java date, properties escaping, manifest folding', () => {
    expect(javaDate(NOW)).toBe('Sat Oct 10 13:05:46 UTC 2026')
    expect(propEscape('https://a.b/c?x=1#f')).toBe('https\\://a.b/c?x\\=1\\#f')
    expect(propEscape(' lead\\ü')).toBe('\\ lead\\\\\\u00FC')
    expect(manifestHeader('K', 'v'.repeat(100)).split('\r\n')[1]).toMatch(/^ v+$/)
  })
})

describe('routers (phase 1b): graph, joins, end events and layout', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const rr = (name, system) => ({ type: 'requestReplyHttp', name, system, url: `https://${system.toLowerCase()}.example.com/api`, method: 'POST', authType: 'None' })
  const spec = baseSpec({
    steps: [
      cm('Prepare'),
      {
        type: 'router',
        name: 'Check',
        expressionType: 'NonXML',
        routes: [
          { name: 'Valid', condition: "${property.ok} = 'true'", steps: [rr('Send', 'ERP')] },
          { name: 'Retry', condition: "${property.ok} = 'retry'", steps: [cm('MarkRetry')] },
          { name: 'Invalid', default: true, steps: [cm('LogInvalid')], end: { event: 'escalation', name: 'End Invalid' } }
        ]
      },
      cm('Join'),
      rr('Notify', 'Notify')
    ],
    exceptionSubprocess: { steps: [cm('SetError')], end: { event: 'error' } }
  })
  const box = (doc, id) => {
    const b = all(all(doc, 'BPMNShape').find((s) => s.getAttribute('bpmnElement') === id), 'Bounds')[0]
    return { x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height') }
  }
  const named = (doc, name) => [...doc.getElementsByTagName('*')].find((e) => e.getAttribute('name') === name)
  const incoming = (el) => all(el, 'incoming').filter((x) => x.parentNode === el).map((x) => x.textContent)

  test('the router writes its default route; continuing routes join at the next step; ending routes end', async () => {
    const { doc } = await built(spec)
    const gateway = all(doc, 'exclusiveGateway')[0]
    const routes = all(doc, 'sequenceFlow').filter((f) => f.getAttribute('sourceRef') === gateway.getAttribute('id'))
    // the spec's order: CPI evaluates routes in order (a route that continues without steps is not moved last)
    expect(routes.map((f) => f.getAttribute('name'))).toEqual(['Valid', 'Retry', 'Invalid'])
    expect(all(gateway, 'outgoing').map((o) => routes.find((f) => f.getAttribute('id') === o.textContent).getAttribute('name'))).toEqual(['Valid', 'Retry', 'Invalid'])
    expect(gateway.getAttribute('default')).toBe(routes.find((f) => f.getAttribute('name') === 'Invalid').getAttribute('id'))
    expect(all(routes.find((f) => f.getAttribute('name') === 'Invalid'), 'conditionExpression')).toEqual([])
    expect(all(routes.find((f) => f.getAttribute('name') === 'Valid'), 'conditionExpression')[0].textContent).toBe("${property.ok} = 'true'")
    // Send (route Valid) and MarkRetry (route Retry) both lead into Join
    expect(incoming(named(doc, 'Join'))).toHaveLength(2)
    const ends = all(doc, 'endEvent').filter((e) => e.parentNode.localName === 'process')
    expect(ends.map((e) => [e.getAttribute('name'), all(e, 'escalationEventDefinition').length + all(e, 'messageEventDefinition').length])).toEqual(
      expect.arrayContaining([
        ['End Invalid', 1],
        ['End', 1]
      ])
    )
    expect(all(named(doc, 'End Invalid'), 'escalationEventDefinition')).toHaveLength(1)
    // the exception subprocess ends with an Error End
    expect(all(all(doc, 'subProcess')[0], 'errorEventDefinition').length).toBe(2) // error start + error end
  })

  test('layout: lanes inside the pool, nothing overlaps, receivers above the pool, the subprocess below every lane', async () => {
    const { doc } = await built(spec)
    const pool = box(doc, 'Participant_Process_1')
    const nodes = [...all(doc, 'callActivity'), ...all(doc, 'serviceTask'), ...all(doc, 'exclusiveGateway'), ...all(doc, 'endEvent'), ...all(doc, 'startEvent')]
      .filter((n) => n.parentNode.localName === 'process')
      .map((n) => ({ id: n.getAttribute('id'), ...box(doc, n.getAttribute('id')) }))
    const sub = box(doc, all(doc, 'subProcess')[0].getAttribute('id'))
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(pool.x)
      expect(n.y + n.h).toBeLessThanOrEqual(sub.y) // every lane above the subprocess
      for (const m of nodes) if (m !== n) expect(overlap(n, m)).toBe(false)
    }
    expect(sub.y + sub.h).toBeLessThanOrEqual(pool.y + pool.h)
    // one column per node: a connector straight up from a step meets no other node
    expect(new Set(nodes.map((n) => n.x + n.w / 2)).size).toBe(nodes.length)
    // receivers above the pool, each in its step's column
    for (const p of all(doc, 'participant').filter((x) => x.getAttribute('ifl:type') === 'EndpointRecevier')) {
      const r = box(doc, p.getAttribute('id'))
      expect(r.y + r.h).toBeLessThan(pool.y)
      const flow = all(doc, 'messageFlow').find((f) => f.getAttribute('targetRef') === p.getAttribute('id'))
      const step = nodes.find((n) => n.id === flow.getAttribute('sourceRef'))
      expect(r.x + r.w / 2).toBe(step.x + step.w / 2)
    }
  })

  test('a route that continues without steps keeps its place among the routes', async () => {
    const r = baseSpec({
      steps: [
        cm('A'),
        { type: 'router', name: 'R', expressionType: 'NonXML', routes: [{ name: 'Go', condition: '${a} = 1' }, { name: 'Stop', condition: '${a} = 2', end: { event: 'escalation' } }, { name: 'Other', default: true, steps: [cm('B')] }] },
        cm('C')
      ]
    })
    const { doc } = await built(r)
    const gateway = all(doc, 'exclusiveGateway')[0]
    const names = all(gateway, 'outgoing').map((o) => all(doc, 'sequenceFlow').find((f) => f.getAttribute('id') === o.textContent).getAttribute('name'))
    expect(names).toEqual(['Go', 'Stop', 'Other'])
  })

  test('a router whose routes all end is the last step, and no main end is built', async () => {
    const lastRouter = baseSpec({
      steps: [cm('A'), { type: 'router', name: 'R', expressionType: 'XML', routes: [{ name: 'X', condition: "/a = 'x'", end: { event: 'message' } }, { name: 'Other', default: true, steps: [cm('B')], end: { event: 'error' } }] }]
    })
    const { doc } = await built(lastRouter)
    const ends = all(doc, 'endEvent').filter((e) => e.parentNode.localName === 'process')
    expect(ends).toHaveLength(2) // one per route, no main end
  })
})

describe('splitters, gathers, process calls and local processes (phase 2)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const rr = (name, system) => ({ type: 'requestReplyHttp', name, system, url: `https://${system.toLowerCase()}.example.com/api`, method: 'POST', authType: 'None' })
  const spec = baseSpec({
    steps: [
      cm('A'),
      { type: 'splitter', name: 'Split', kind: 'iterating', expression: '//item', stopOnException: false },
      { type: 'processCall', name: 'Handle', process: 'LIP_Handle' },
      { type: 'gather', name: 'Gather', source: '//item', target: '/items' },
      { type: 'processCall', name: 'Loop', process: 'LIP_Page', loop: { condition: "${property.more} = 'a&b' and ${property.n} < 5", max: 3 } }
    ],
    exceptionSubprocess: { steps: [{ type: 'processCall', name: 'OnError', process: 'LIP_Handle' }], end: { event: 'escalation' } },
    localProcesses: [
      { name: 'LIP_Handle', steps: [cm('H1'), rr('H2', 'Backend'), cm('H3')] },
      { name: 'LIP_Page', steps: [cm('P1'), rr('P2', 'Pages')] }
    ]
  })
  const box = (doc, id) => {
    const b = all(all(doc, 'BPMNShape').find((s) => s.getAttribute('bpmnElement') === id), 'Bounds')[0]
    return { id, x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height') }
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const inside = (a, b) => a.x >= b.x && a.x + a.w <= b.x + b.w && a.y >= b.y && a.y + a.h <= b.y + b.h

  test('every id once; each local process is a process with its own pool; process calls name it by id', async () => {
    const { doc, result } = await built(spec)
    const ids = [...doc.getElementsByTagName('*')].map((e) => e.getAttribute('id')).filter(Boolean)
    expect(ids.filter((v, i) => ids.indexOf(v) !== i)).toEqual([])
    const processes = all(doc, 'process').map((p) => [p.getAttribute('id'), p.getAttribute('name')])
    expect(processes[0]).toEqual(['Process_1', 'Integration Process'])
    const idOf = (name) => processes.find(([, n]) => n === name)[0]
    const pools = all(doc, 'participant').filter((p) => p.getAttribute('ifl:type') === 'IntegrationProcess')
    expect(pools.map((p) => [p.getAttribute('name'), p.getAttribute('processRef')])).toEqual(
      expect.arrayContaining([['LIP_Handle', idOf('LIP_Handle')], ['LIP_Page', idOf('LIP_Page')]])
    )
    // main line, loop and the exception subprocess
    expect(props(stepElement(doc, 'Handle')).processId).toBe(idOf('LIP_Handle'))
    expect(props(stepElement(doc, 'Loop')).processId).toBe(idOf('LIP_Page'))
    expect(props(stepElement(doc, 'OnError')).processId).toBe(idOf('LIP_Handle'))
    expect(result.summary.localProcesses.map((p) => [p.name, p.steps.map((s) => s.name)])).toEqual([
      ['LIP_Handle', ['H1', 'H2', 'H3']],
      ['LIP_Page', ['P1', 'P2']]
    ])
  })

  test('a Looping Process Call: loop characteristics with the escaped condition and the maximum', async () => {
    const { doc, iflw } = await built(spec)
    const loop = all(stepElement(doc, 'Loop'), 'standardLoopCharacteristics')[0]
    expect(loop.getAttribute('loopMaximum')).toBe('3')
    expect(props(stepElement(doc, 'Loop')).loopId).toBe(loop.getAttribute('id'))
    expect(all(loop, 'loopCondition')[0].textContent).toBe("${property.more} = 'a&b' and ${property.n} < 5")
    expect(iflw).toContain("${property.more} = 'a&amp;b' and ${property.n} &lt; 5")
    expect(all(stepElement(doc, 'Handle'), 'standardLoopCharacteristics')).toHaveLength(0)
  })

  test('layout: local pools below the main pool, their nodes inside, their receivers below them; nothing overlaps', async () => {
    const { doc } = await built(spec)
    const main = box(doc, 'Participant_Process_1')
    const pools = all(doc, 'participant')
      .filter((p) => p.getAttribute('ifl:type') === 'IntegrationProcess' && p.getAttribute('id') !== 'Participant_Process_1')
      .map((p) => ({ ...box(doc, p.getAttribute('id')), process: p.getAttribute('processRef') }))
    let above = main
    for (const pool of pools) {
      expect(pool.y).toBeGreaterThanOrEqual(above.y + above.h)
      const process = all(doc, 'process').find((p) => p.getAttribute('id') === pool.process)
      const nodes = [...process.childNodes].filter((n) => n.nodeType === 1 && /Event$|callActivity|serviceTask/.test(n.localName)).map((n) => box(doc, n.getAttribute('id')))
      expect(nodes.length).toBeGreaterThan(2)
      for (const n of nodes) expect(inside(n, pool)).toBe(true)
      above = pool
    }
    // receivers: of the main line above the main pool (none here), of local steps below their pool; none overlaps a pool
    const receivers = all(doc, 'participant').filter((x) => x.getAttribute('ifl:type') === 'EndpointRecevier').map((p) => box(doc, p.getAttribute('id')))
    expect(receivers).toHaveLength(2)
    for (const r of receivers) for (const pool of [main, ...pools]) expect(overlap(r, pool)).toBe(false)
    for (const p of all(doc, 'participant').filter((x) => x.getAttribute('ifl:type') === 'EndpointRecevier')) {
      const flow = all(doc, 'messageFlow').find((f) => f.getAttribute('targetRef') === p.getAttribute('id'))
      const step = box(doc, flow.getAttribute('sourceRef'))
      const r = box(doc, p.getAttribute('id'))
      expect(r.y).toBeGreaterThan(step.y + step.h) // below its step
      expect(r.x + r.w / 2).toBe(step.x + step.w / 2) // in its column
    }
    // every edge points to shapes that exist
    for (const e of all(doc, 'BPMNEdge')) expect(byId(doc, e.getAttribute('sourceElement'))).toBeDefined()
  })

  test('default names as in the CPI editor: Iterating / General Splitter, Gather, (Looping) Process Call', async () => {
    const { result } = await built(
      baseSpec({
        steps: [
          { type: 'splitter', kind: 'general', expression: '/a/b', stopOnException: true },
          { type: 'processCall', process: 'L' },
          { type: 'gather', source: '//b', target: '/a' },
          { type: 'splitter', kind: 'iterating', expression: '//b', stopOnException: true },
          { type: 'processCall', process: 'L', loop: { condition: '${property.x} = 1', max: 2 } }
        ],
        localProcesses: [{ name: 'L', steps: [cm('X')] }]
      })
    )
    expect(result.summary.steps.map((s) => s.name)).toEqual(['General Splitter 1', 'Process Call 1', 'Gather 1', 'Iterating Splitter 1', 'Looping Process Call 1'])
  })
})

describe('routers in local processes (phase 2 tenant check: route per item inside a local process)', () => {
  const { parse } = require('../srv/iflow-builder/parser')
  const { specFromParsed } = require('../srv/iflow-builder/to-spec')
  const { importIflow } = require('../srv/iflow-builder/import')
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const spec = baseSpec({
    steps: [
      { type: 'splitter', name: 'Split', kind: 'iterating', expression: '//order', stopOnException: false },
      { type: 'processCall', name: 'PC', process: 'LIP_Route' },
      { type: 'gather', name: 'Gather', source: '//order', target: '/orders' }
    ],
    end: { type: 'none' },
    localProcesses: [
      {
        name: 'LIP_Route',
        steps: [
          cm('L_Before'),
          {
            type: 'router',
            name: 'LR',
            expressionType: 'XML',
            routes: [
              { name: 'R_A', condition: "/order/type = 'A'", steps: [{ type: 'requestReplyHttp', name: 'RR_A', system: 'SysA', url: 'https://a.example.com/x', method: 'POST', authType: 'None' }] },
              { name: 'R_Skip', condition: "/order/type = 'C'", end: { event: 'message', name: 'End_Skip' } },
              { name: 'R_Other', default: true }
            ]
          },
          cm('L_After')
        ]
      }
    ]
  })
  const box = (doc, id) => {
    const b = all(all(doc, 'BPMNShape').find((s) => s.getAttribute('bpmnElement') === id), 'Bounds')[0]
    return { x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height') }
  }

  test('lanes inside the local pool: nothing overlaps, the route end is a plain End, the receiver below the pool', async () => {
    const { doc } = await built(spec)
    const process = all(doc, 'process').find((p) => p.getAttribute('name') === 'LIP_Route')
    const pool = box(doc, all(doc, 'participant').find((p) => p.getAttribute('processRef') === process.getAttribute('id')).getAttribute('id'))
    const nodes = [...process.childNodes].filter((n) => n.nodeType === 1 && /Event$|callActivity|serviceTask|Gateway$/.test(n.localName))
    const boxes = nodes.map((n) => box(doc, n.getAttribute('id')))
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (const b of boxes) {
      expect(b.x >= pool.x && b.x + b.w <= pool.x + pool.w && b.y >= pool.y && b.y + b.h <= pool.y + pool.h).toBe(true)
      for (const c of boxes) if (c !== b) expect(overlap(b, c)).toBe(false)
    }
    // two plain End events (the route's and the process's), no message end definition
    const ends = nodes.filter((n) => n.localName === 'endEvent')
    expect(ends.map((n) => n.getAttribute('name')).sort()).toEqual(['End 2', 'End_Skip'])
    for (const e of ends) expect(props(e).activityType).toBe('EndEvent')
    const receiver = box(doc, all(doc, 'participant').find((p) => p.getAttribute('name') === 'SysA').getAttribute('id'))
    expect(receiver.y).toBeGreaterThan(pool.y + pool.h)
  })

  test('parse, update and import give the same local process back', async () => {
    const zip = (await build(spec)).zipBase64
    const parsed = await parse(zip)
    const lip = parsed.localProcessSteps.find((p) => p.name === 'LIP_Route')
    expect(lip).toMatchObject({ routed: true, end: 'message' })
    expect(lip.steps.map((s) => s.name)).toEqual(['L_Before', 'LR', 'L_After'])
    const update = specFromParsed(parsed, { packageId: spec.packageId })
    expect(update.blockers).toEqual([])
    expect(update.spec.localProcesses).toEqual(spec.localProcesses)
    const imported = await importIflow(Buffer.from(zip, 'base64'), { fileName: 'lr.zip', packageId: spec.packageId })
    expect(imported).toMatchObject({ valid: true, placeholders: 0 })
    expect(imported.spec.localProcesses).toEqual(spec.localProcesses)
  })
})

describe('SOAP 1.x and Mail receivers (phase 3)', () => {
  const soap = (name, system) => ({ type: 'requestReplySoap', name, system, url: 'http://s4dummy:8000/x', authType: 'Basic', credentialName: 'CRED', proxyType: 'On-Premise', locationId: 'LOC' })
  const mail = (name, system, extra = {}) => ({ type: 'sendMail', name, system, server: 'smtp.example.com:587', credentialName: 'CRED', from: 'a@example.com', to: 'b@example.com', subject: 'Hi & bye', ...extra })
  const spec = baseSpec({
    steps: [soap('S1', 'SysS1'), mail('M1', 'SysM1'), { type: 'processCall', name: 'PC', process: 'L' }],
    exceptionSubprocess: { steps: [mail('Alert', 'SysAlert', { body: 'Failed: ${exception.message}' })], end: { event: 'escalation' } },
    localProcesses: [{ name: 'L', steps: [soap('S2', 'SysS2')] }]
  })
  const box = (doc, id) => {
    const b = all(all(doc, 'BPMNShape').find((s) => s.getAttribute('bpmnElement') === id), 'Bounds')[0]
    return { x: +b.getAttribute('x'), y: +b.getAttribute('y'), w: +b.getAttribute('width'), h: +b.getAttribute('height') }
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const flowOf = (doc, name) => {
    const task = all(doc, 'serviceTask').find((t) => t.getAttribute('name') === name)
    return all(doc, 'messageFlow').find((f) => f.getAttribute('sourceRef') === task.getAttribute('id'))
  }

  test('each step gets its own adapter: SOAP on a Request Reply, Mail on a Send step; values escaped; default body', async () => {
    const { doc, iflw, result } = await built(spec)
    expect(props(all(doc, 'serviceTask').find((t) => t.getAttribute('name') === 'S1')).activityType).toBe('ExternalCall')
    expect(props(all(doc, 'serviceTask').find((t) => t.getAttribute('name') === 'M1')).activityType).toBe('Send')
    expect(props(flowOf(doc, 'S1'))).toMatchObject({ ComponentType: 'SOAP', address: 'http://s4dummy:8000/x', credentialName: 'CRED', location_id: 'LOC', apiprovider_location_id: 'LOC', requestTimeout: '60000', system: 'SysS1' })
    expect(props(flowOf(doc, 'M1'))).toMatchObject({ ComponentType: 'Mail', server: 'smtp.example.com:587', user: 'CRED', to: 'b@example.com', cc: '', subject: 'Hi & bye', body: '${in.body}', system: 'SysM1' })
    expect(iflw).toContain('Hi &amp; bye')
    expect(props(flowOf(doc, 'Alert')).body).toBe('Failed: ${exception.message}')
    expect(result.summary.adapters.filter((a) => a.direction === 'Receiver').map((a) => [a.type, a.system]).sort()).toEqual([['Mail', 'SysAlert'], ['Mail', 'SysM1'], ['SOAP', 'SysS1'], ['SOAP', 'SysS2']])
  })

  test('layout: main receivers above, the alert mail receiver below the main pool, the local pool below that, nothing overlaps', async () => {
    const { doc } = await built(spec)
    const main = box(doc, 'Participant_Process_1')
    const receiver = (name) => box(doc, flowOf(doc, name).getAttribute('targetRef'))
    expect(receiver('S1').y + receiver('S1').h).toBeLessThan(main.y)
    expect(receiver('M1').y + receiver('M1').h).toBeLessThan(main.y)
    const alert = receiver('Alert')
    expect(alert.y).toBeGreaterThan(main.y + main.h)
    const step = box(doc, all(doc, 'serviceTask').find((t) => t.getAttribute('name') === 'Alert').getAttribute('id'))
    expect(alert.x + alert.w / 2).toBe(step.x + step.w / 2) // straight down from its step
    const local = box(doc, all(doc, 'participant').find((p) => p.getAttribute('name') === 'L').getAttribute('id'))
    expect(local.y).toBeGreaterThan(alert.y + alert.h)
    expect(receiver('S2').y).toBeGreaterThan(local.y + local.h)
    const ids = [...doc.getElementsByTagName('*')].map((e) => e.getAttribute('id')).filter(Boolean)
    expect(ids.filter((v, i) => ids.indexOf(v) !== i)).toEqual([])
    for (const a of [alert, receiver('S1'), receiver('M1'), receiver('S2')]) for (const pool of [main, local]) expect(overlap(a, pool)).toBe(false)
  })

  test('a parameter gets its reference in parameters.propdef; a literal does not', async () => {
    const withParams = baseSpec({
      steps: [{ ...soap('S', 'SysS'), url: '{{U}}' }, mail('M', 'SysM', { server: '{{Sv}}', credentialName: '{{C}}', to: '{{T}}' })],
      parameters: { U: 'http://s4dummy/x', Sv: 'h:25', C: 'CRED', T: 'a@example.com' }
    })
    const { files } = await built(withParams)
    const refs = [...files['src/main/resources/parameters.propdef'].matchAll(/attribute_category="([^"]+)"[^>]*attrId::(\w+)"[^>]*param_key="([^"]+)"/g)].map((m) => m.slice(1))
    expect(refs).toEqual([['SysS.Receiver.System', 'address', 'U'], ['SysM', 'server', 'Sv'], ['SysM', 'to', 'T'], ['SysM', 'user', 'C']])
  })
})

describe('gather: Combine or Combine at XPath', () => {
  test('the stored algorithm and XPaths', async () => {
    const split = (name) => ({ type: 'splitter', name, kind: 'iterating', expression: '//item', stopOnException: false })
    const { doc } = await built(baseSpec({ steps: [split('S1'), { type: 'gather', name: 'Combine' }, split('S2'), { type: 'gather', name: 'AtXPath', source: '//item', target: '/items' }] }))
    expect(props(stepElement(doc, 'Combine'))).toMatchObject({ messageType: 'SameXMLFormat', aggregationAlgorithm: 'sap-identical-multi-mapping', sourceXPath: '', targetXPath: '' })
    expect(props(stepElement(doc, 'AtXPath'))).toMatchObject({ messageType: 'SameXMLFormat', aggregationAlgorithm: 'xpath-merge-strategy', sourceXPath: '//item', targetXPath: '/items' })
  })
})

describe('Message Mapping and XSLT Mapping (phase 4)', () => {
  const attachments = { 't.xsl': '<xsl/>', 'X.mmap': '<m/>', 'a.xsd': '<a/>', 'b.wsdl': '<b/>' }
  test('files go to mapping/, xsd/ and wsdl/, each once, also when two steps share them; an artifact adds no file', async () => {
    const spec = baseSpec({
      steps: [
        { type: 'messageMapping', name: 'A', mapping: 'MM_Art' },
        { type: 'xsltMapping', name: 'T1', file: 't.xsl' },
        { type: 'xsltMapping', name: 'T2', file: 't.xsl' },
        { type: 'messageMapping', name: 'I1', file: 'X.mmap', schemas: ['a.xsd', 'b.wsdl'] },
        { type: 'messageMapping', name: 'I2', file: 'X.mmap', schemas: ['a.xsd', 'b.wsdl'] }
      ]
    })
    const { files } = await build(spec, { attachments })
    const paths = files.map((f) => f.path).filter((p) => /mapping\/|xsd\/|wsdl\//.test(p)).sort()
    expect(paths).toEqual(['src/main/resources/mapping/X.mmap', 'src/main/resources/mapping/t.xsl', 'src/main/resources/wsdl/b.wsdl', 'src/main/resources/xsd/a.xsd'])
    const doc = parseXml(files.find((f) => f.path.endsWith('.iflw')).content)
    expect(props(stepElement(doc, 'A'))).toMatchObject({ messageMappingBundleId: 'MM_Art', mappinguri: 'dir://mmap/src/main/resources/mapping/MM_Art.mmap', mappingname: 'MM_Art' })
    expect(props(stepElement(doc, 'I1'))).toMatchObject({ messageMappingBundleId: '', mappinguri: 'dir://mmap/src/main/resources/mapping/X.mmap', mappingname: 'X' })
    expect(props(stepElement(doc, 'T1'))).toMatchObject({ mappinguri: 'dir://mapping/xslt/src/main/resources/mapping/t.xsl', mappingname: 't', mappingHeaderNameKey: '', mappingSource: 'mappingSrcIflow', mappingoutputformat: 'Bytes' })
  })
})
