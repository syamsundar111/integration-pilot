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
    await expect(build(baseSpec({ steps: [{ type: 'splitter' }] }))).rejects.toMatchObject({ code: 'INVALID_SPEC', errors: [expect.stringContaining("'splitter' is not supported yet")] })
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
