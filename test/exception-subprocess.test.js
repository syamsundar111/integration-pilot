/**
 * Exception subprocess (validator, builder, parser) and the parsed iFlow -> spec conversion
 * used to update existing iFlows.
 */
const { validate } = require('../srv/iflow-builder/validator')
const { build } = require('../srv/iflow-builder/builder')
const { parse } = require('../srv/iflow-builder/parser')
const { specFromParsed, describeChanges } = require('../srv/iflow-builder/to-spec')
const schema = require('../srv/iflow-builder/spec-schema.json')
const { baseSpec, allStepsSpec, readRef, GROOVY, unzip, parseXml, all, propList, elements } = require('./helpers')

const NOW = new Date('2026-10-10T13:05:46Z')
const ERROR_BODY = '{"status": "Failed", "error": "${exception.message}"}'

/** The flow from the original request: JSON to XML, errors returned to the sender */
const orderSpec = (overrides = {}) =>
  baseSpec({
    id: 'Order_JSON_to_XML',
    name: 'Order JSON to XML',
    steps: [{ type: 'jsonToXml' }],
    exceptionSubprocess: { steps: [{ type: 'contentModifier', name: 'Set Error Body', body: ERROR_BODY }] },
    ...overrides
  })

async function built(spec) {
  const result = await build(spec, { now: NOW })
  const files = await unzip(result.zipBase64)
  const iflw = files[`src/main/resources/scenarioflows/integrationflow/${spec.id}.iflw`]
  return { result, files, iflw, doc: parseXml(iflw) }
}

const errorsOf = (spec) => validate(spec).errors
const props = (el) => Object.fromEntries(propList(el))
const shapeOf = (doc, id) => all(doc, 'BPMNShape').find((s) => s.getAttribute('bpmnElement') === id)
const bounds = (shape) => {
  const b = elements(shape).find((e) => e.localName === 'Bounds')
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Number(b.getAttribute(k))]))
}

describe('exception subprocess: validator', () => {
  test('accepts the request from the field (Set Error Body with ${exception.message})', () => {
    expect(errorsOf(orderSpec())).toEqual([])
    expect(errorsOf(schema.examples.find((e) => e.exceptionSubprocess))).toEqual([])
  })

  test('error handling written as a step points to exceptionSubprocess', () => {
    for (const type of ['exceptionSubprocess', 'errorHandler', 'tryCatch'])
      expect(errorsOf(baseSpec({ steps: [{ type }] })).join('\n')).toMatch(/error handling is not a step .* top-level 'exceptionSubprocess'/)
  })

  test('only processing steps are allowed inside, at least one', () => {
    const rr = { type: 'requestReplyHttp', url: 'https://example.org', method: 'GET', authType: 'None' }
    expect(errorsOf(orderSpec({ exceptionSubprocess: { steps: [rr] } })).join('\n')).toMatch(/exceptionSubprocess\.steps\[0\]: requestReplyHttp is not supported in the exception subprocess/)
    expect(errorsOf(orderSpec({ exceptionSubprocess: { steps: [] } })).join('\n')).toMatch(/exceptionSubprocess\.steps/)
    expect(errorsOf(orderSpec({ exceptionSubprocess: { steps: [{ type: 'jsonToXml' }], extra: 1 } })).join('\n')).toMatch(/unknown field 'extra'/)
  })

  test('names, script files and Groovy rules apply across main flow and subprocess', () => {
    const errors = errorsOf(
      orderSpec({
        steps: [{ type: 'groovyScript', name: 'Same', fileName: 'shared', code: GROOVY }],
        exceptionSubprocess: { steps: [{ type: 'groovyScript', name: 'Same', fileName: 'shared', code: 'println 1' }] }
      })
    ).join('\n')
    expect(errors).toMatch(/step name 'Same' is used more than once/)
    expect(errors).toMatch(/Groovy fileName 'shared' is used more than once/)
    expect(errors).toMatch(/exceptionSubprocess\.steps\[0\]\.code: Groovy script must import/)
  })

  test('no secrets and no {{parameters}} in the subprocess', () => {
    const errors = errorsOf(
      orderSpec({ exceptionSubprocess: { steps: [{ type: 'contentModifier', headers: [{ name: 'Password', type: 'constant', value: 'x' }, { name: 'X', type: 'constant', value: '{{Url}}' }] }] } })
    ).join('\n')
    expect(errors).toMatch(/exceptionSubprocess\.steps\[0\]\.headers\[0\]: 'Password' looks like a secret/)
    expect(errors).toMatch(/exceptionSubprocess\.steps\[0\]\.headers\[1\]\.value: parameters/)
  })
})

describe('exception subprocess: builder', () => {
  test('builds an ErrorEventSubProcessTemplate: error start -> steps -> message end, inside the process', async () => {
    const { doc, result } = await built(orderSpec())
    const process = all(doc, 'process')[0]
    const sub = elements(process).find((e) => e.localName === 'subProcess')
    expect(sub.getAttribute('name')).toBe('Exception Subprocess 1')
    expect(props(sub)).toMatchObject({ activityType: 'ErrorEventSubProcessTemplate', cmdVariantUri: expect.stringContaining('cname::ErrorEventSubProcessTemplate') })

    const [start, cm, end, ...flows] = elements(sub).filter((e) => e.localName !== 'extensionElements')
    expect([start.localName, cm.localName, end.localName]).toEqual(['startEvent', 'callActivity', 'endEvent'])
    expect(all(start, 'errorEventDefinition')).toHaveLength(1)
    expect(all(end, 'messageEventDefinition')).toHaveLength(1)
    expect(props(cm)).toMatchObject({ activityType: 'Enricher', bodyType: 'expression', wrapContent: ERROR_BODY })
    expect(cm.getAttribute('name')).toBe('Set Error Body')
    // the subprocess's sequence flows live inside it and connect its own elements
    expect(flows.map((f) => [f.getAttribute('sourceRef'), f.getAttribute('targetRef')])).toEqual([
      [start.getAttribute('id'), cm.getAttribute('id')],
      [cm.getAttribute('id'), end.getAttribute('id')]
    ])

    // the main flow is unchanged: start -> converter -> end
    const mainFlows = elements(process).filter((e) => e.localName === 'sequenceFlow')
    expect(mainFlows).toHaveLength(2)

    expect(result.summary.exceptionSubprocess).toEqual({ id: sub.getAttribute('id'), name: 'Exception Subprocess 1', steps: [{ id: cm.getAttribute('id'), type: 'contentModifier', name: 'Set Error Body' }] })
  })

  test('every element has a shape; the subprocess sits inside the pool, below the main flow', async () => {
    const { doc } = await built(orderSpec())
    const ids = [...doc.getElementsByTagName('*')].map((e) => e.getAttribute('id')).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    for (const el of [...all(doc, 'subProcess'), ...all(doc, 'startEvent'), ...all(doc, 'endEvent'), ...all(doc, 'callActivity')])
      expect(shapeOf(doc, el.getAttribute('id'))).toBeDefined()
    for (const f of all(doc, 'sequenceFlow')) expect(all(doc, 'BPMNEdge').some((e) => e.getAttribute('bpmnElement') === f.getAttribute('id'))).toBe(true)

    const pool = bounds(shapeOf(doc, 'Participant_Process_1'))
    const sub = bounds(shapeOf(doc, all(doc, 'subProcess')[0].getAttribute('id')))
    const mainStep = bounds(shapeOf(doc, all(doc, 'callActivity')[0].getAttribute('id')))
    expect(sub.y).toBeGreaterThan(mainStep.y + mainStep.height)
    expect(sub.x).toBeGreaterThanOrEqual(pool.x)
    expect(sub.x + sub.width).toBeLessThanOrEqual(pool.x + pool.width)
    expect(sub.y + sub.height).toBeLessThanOrEqual(pool.y + pool.height)
    for (const el of elements(all(doc, 'subProcess')[0]).filter((e) => ['startEvent', 'callActivity', 'endEvent'].includes(e.localName))) {
      const b = bounds(shapeOf(doc, el.getAttribute('id')))
      expect(b.x).toBeGreaterThan(sub.x)
      expect(b.x + b.width).toBeLessThan(sub.x + sub.width)
    }
  })

  test('request-reply receivers move below the taller pool', async () => {
    const rr = { type: 'requestReplyHttp', url: 'https://example.org', method: 'GET', authType: 'None' }
    const { doc } = await built(orderSpec({ steps: [rr] }))
    const pool = bounds(shapeOf(doc, 'Participant_Process_1'))
    const receiver = all(doc, 'participant').find((p) => p.getAttribute('ifl:type') === 'EndpointRecevier')
    expect(bounds(shapeOf(doc, receiver.getAttribute('id'))).y).toBeGreaterThan(pool.y + pool.height)
  })

  test('Groovy scripts of the subprocess are bundled; without a subprocess nothing changes', async () => {
    const { files } = await built(orderSpec({ exceptionSubprocess: { steps: [{ type: 'groovyScript', fileName: 'logError', code: GROOVY }] } }))
    expect(files['src/main/resources/script/logError.groovy']).toBe(GROOVY)
    const plain = await built(baseSpec({ steps: [{ type: 'jsonToXml' }] }))
    expect(all(plain.doc, 'subProcess')).toEqual([])
    expect(plain.result.summary.exceptionSubprocess).toBeNull()
  })
})

describe('exception subprocess: parser', () => {
  test('reports the subprocess separately; the main flow stays linear', async () => {
    const parsed = await parse((await build(orderSpec(), { now: NOW })).zipBase64)
    expect(parsed.linear).toBe(true)
    expect(parsed.steps.map((s) => s.type)).toEqual(['jsonToXml'])
    expect(parsed.exceptionSubprocess).toMatchObject({ name: 'Exception Subprocess 1', steps: [{ type: 'contentModifier', name: 'Set Error Body', body: ERROR_BODY }] })
  })

  test('iFlows without one report null', async () => {
    expect((await parse(readRef('Reference_AllSteps.zip'))).exceptionSubprocess).toBeNull()
  })
})

describe('parsed iFlow -> spec (update)', () => {
  /** spec -> zip -> parse -> spec -> zip: the second build must be identical */
  async function roundTrip(spec) {
    const first = await build(spec, { now: NOW })
    const parsed = await parse(first.zipBase64)
    const { spec: again, blockers } = specFromParsed(parsed, { packageId: spec.packageId })
    expect(blockers).toEqual([])
    const second = await build(again, { now: NOW })
    const iflw = (r) => r.files.find((f) => f.path.endsWith('.iflw')).content
    expect(iflw(second)).toBe(iflw(first))
    expect(second.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path))
    return again
  }

  test('round-trips the reference flow and a flow with an exception subprocess', async () => {
    await roundTrip(await allStepsSpec())
    const again = await roundTrip(orderSpec({ exceptionSubprocess: { steps: [{ type: 'contentModifier', name: 'Set Error Body', headers: [{ name: 'CamelHttpResponseCode', type: 'constant', value: '500' }], body: ERROR_BODY }] } }))
    expect(again.exceptionSubprocess.steps[0].headers).toEqual([{ name: 'CamelHttpResponseCode', type: 'constant', value: '500' }]) // no 'action' column
  })

  test('the Reference_AllSteps export is updatable; configured values win over defaults', async () => {
    const parsed = await parse(readRef('Reference_AllSteps.zip'))
    const { spec, blockers } = specFromParsed(parsed, { packageId: 'PilotReference', configurations: [{ key: 'TargetURL', value: 'https://prod.example.org/post' }] })
    expect(blockers).toEqual([])
    expect(spec.parameters).toEqual({ TargetURL: 'https://prod.example.org/post', FinalURL: 'https://httpbin.org/post' })
  })

  test('content an update would lose is reported as blockers', async () => {
    const parsed = await parse(readRef('Reference_AllSteps.zip'))
    const tampered = {
      ...parsed,
      linear: false,
      steps: [...parsed.steps, { type: 'router', name: 'Router 1' }],
      end: { ...parsed.end, authType: 'OAuth2ClientCredentials' },
      files: [...parsed.files, 'src/main/resources/mapping/Orders.mmap']
    }
    const { spec, blockers } = specFromParsed(tampered, { packageId: 'PilotReference' })
    expect(spec).toBeNull()
    expect(blockers.join('\n')).toMatch(/flow branches/)
    expect(blockers.join('\n')).toMatch(/step 6 'Router 1': router/)
    expect(blockers.join('\n')).toMatch(/authentication 'OAuth2ClientCredentials'/)
    expect(blockers.join('\n')).toMatch(/resource mapping\/Orders\.mmap/)
  })

  test('describeChanges lists what the update does', () => {
    const before = baseSpec({ steps: [{ type: 'jsonToXml' }] })
    expect(describeChanges(before, orderSpec({ id: before.id, name: before.name }))).toEqual(['exception subprocess added: Set Error Body'])
    expect(describeChanges(before, before)).toEqual([])
  })
})
