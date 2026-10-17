const { parse, parseProperties } = require('../srv/iflow-builder/parser')
const { build } = require('../srv/iflow-builder/builder')
const sample = require('../srv/iflow-builder/samples/Pilot_Test_1.json')
const { readRef, allStepsSpec, baseSpec, GROOVY } = require('./helpers')

describe('parser', () => {
  test('parses Reference_AllSteps.zip', async () => {
    const r = await parse(readRef('Reference_AllSteps.zip'))
    expect(r).toMatchObject({
      id: 'Reference_AllSteps',
      name: 'Reference_AllSteps',
      linear: true,
      trigger: { type: 'httpsSender', address: '/pilot/reference' },
      end: { type: 'httpReceiver', system: 'Receiver', url: '{{FinalURL}}', method: 'POST', authType: 'None' },
      parameters: { TargetURL: 'https://httpbin.org/post', FinalURL: 'https://httpbin.org/post' }
    })
    expect(r.steps.map((s) => s.type)).toEqual(['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson', 'requestReplyHttp'])
    expect(r.steps[0]).toMatchObject({
      headers: [{ name: 'Source', type: 'constant', value: 'Pilot' }],
      properties: [{ name: 'OrderId', type: 'expression', value: '${header.Source}' }],
      body: '{"hello":"world"}'
    })
    expect(r.steps[4]).toMatchObject({ system: 'Receiver1', url: '{{TargetURL}}' })
    expect(r.scripts).toEqual([expect.objectContaining({ fileName: 'script1.groovy', content: expect.stringContaining('def Message processData(Message message)') })])
    expect(r.adapters.map((a) => `${a.direction}:${a.type}`)).toEqual(['Sender:HTTPS', 'Receiver:HTTP', 'Receiver:HTTP'])
  })

  test('parses Reference_Timer.zip', async () => {
    const r = await parse(readRef('Reference_Timer.zip'))
    expect(r).toMatchObject({ id: 'Reference_Timer', trigger: { type: 'timer', mode: 'once' }, end: { type: 'none' }, parameters: {}, scripts: [] })
    expect(r.steps.map((s) => s.type)).toEqual(['contentModifier'])
  })

  test('accepts base64 input and rejects non-iFlow zips', async () => {
    const r = await parse(readRef('Reference_Timer.zip').toString('base64'))
    expect(r.id).toBe('Reference_Timer')
    await expect(parse(Buffer.from('not a zip'))).rejects.toMatchObject({ code: 'INVALID_ZIP' })
  })

  test('parseProperties handles Java escapes', () => {
    expect(parseProperties('#c\nA=https\\://x\nB\\ C = v\\u00FC\n! other\n')).toEqual({ A: 'https://x', 'B C': 'vü' })
  })
})

describe('round trip: build -> parse', () => {
  /** Reduces a spec to what the parser reports, using builder default names */
  async function roundTrip(spec) {
    const { zipBase64, summary } = await build(spec)
    const parsed = await parse(zipBase64)
    expect(parsed.id).toBe(spec.id)
    expect(parsed.name).toBe(spec.name)
    expect(parsed.description).toBe(spec.description || '')
    expect(parsed.linear).toBe(true)
    expect(parsed.trigger).toMatchObject(spec.trigger)
    expect(parsed.steps.map((s) => ({ type: s.type, name: s.name }))).toEqual(summary.steps.map((s) => ({ type: s.type, name: s.name })))
    spec.steps.forEach((s, i) => {
      const p = parsed.steps[i]
      if (s.type === 'contentModifier') {
        expect(p.headers.map(({ action, ...e }) => e)).toEqual(s.headers || [])
        expect(p.properties.map(({ action, ...e }) => e)).toEqual(s.properties || [])
        expect(p.body).toBe(s.body)
      }
      if (s.type === 'groovyScript') {
        expect(p.fileName).toBe(s.fileName)
        expect(parsed.scripts.find((x) => x.fileName === `${s.fileName}.groovy`).content).toBe(s.code)
      }
      if (s.type === 'requestReplyHttp') expect(p).toMatchObject({ url: s.url, method: s.method, authType: 'None' })
    })
    const { system, ...end } = spec.end
    expect(parsed.end).toMatchObject(end)
    expect(parsed.parameters).toEqual(spec.parameters || {})
    return parsed
  }

  test('sample spec', () => roundTrip(sample))
  test('reference-equivalent spec (all step types)', async () => roundTrip(await allStepsSpec()))
  test('timer flow with parameterized receiver and description', () =>
    roundTrip(
      baseSpec({
        description: 'Runs once: übersicht = 100%',
        trigger: { type: 'timer', mode: 'once' },
        steps: [{ type: 'groovyScript', fileName: 'g', code: GROOVY }, { type: 'xmlToJson' }],
        end: { type: 'httpReceiver', url: '{{Url}}', method: 'POST', authType: 'None' },
        parameters: { Url: 'https://x.org/a=b' }
      })
    ))
})
