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
    expect(p).toMatchObject({ activityType: 'Enricher', bodyType: 'expression', wrapContent: '<root/>' })
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
    await expect(build(baseSpec({ steps: [{ type: 'router' }] }))).rejects.toMatchObject({ code: 'INVALID_SPEC', errors: [expect.stringContaining("'router' is not supported in v1")] })
  })

  test('helpers: java date, properties escaping, manifest folding', () => {
    expect(javaDate(NOW)).toBe('Sat Oct 10 13:05:46 UTC 2026')
    expect(propEscape('https://a.b/c?x=1#f')).toBe('https\\://a.b/c?x\\=1\\#f')
    expect(propEscape(' lead\\ü')).toBe('\\ lead\\\\\\u00FC')
    expect(manifestHeader('K', 'v'.repeat(100)).split('\r\n')[1]).toMatch(/^ v+$/)
  })
})
