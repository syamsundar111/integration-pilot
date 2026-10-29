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

describe('main process: by type, not by position (Ref_Structure: a local process comes first in the file)', () => {
  const JSZip = require('jszip')
  const { importIflow } = require('../srv/iflow-builder/import')
  const { specFromParsed } = require('../srv/iflow-builder/to-spec')

  /** Ref_Structure with LIP_FetchPage turned into a second integration process (no processType directCall) */
  async function twoIntegrationProcesses() {
    const zip = await JSZip.loadAsync(readRef('Ref_Structure.zip'))
    const name = Object.keys(zip.files).find((f) => f.endsWith('.iflw'))
    const xml = await zip.file(name).async('string')
    const start = xml.indexOf('<bpmn2:process id="Process_16"')
    const end = xml.indexOf('</bpmn2:extensionElements>', start)
    const head = xml.slice(start, end).replace(/<ifl:property>\s*<key>processType<\/key>\s*<value>directCall<\/value>\s*<\/ifl:property>/, '')
    zip.file(name, xml.slice(0, start) + head + xml.slice(end))
    return zip.generateAsync({ type: 'nodebuffer' })
  }

  test('the integration process is the main flow; the local processes stay local', async () => {
    const r = await parse(readRef('Ref_Structure.zip'))
    expect(r.trigger).toMatchObject({ type: 'timer', mode: 'once' })
    expect(r.steps.map((s) => s.name)).toEqual(['CM_SetBody', 'ITSPL_Orders', 'PC_HandleOrder', 'GA_Orders', 'LPC_FetchPages', 'GSPL_Orders'])
    expect(r.integrationProcesses).toEqual(['Integration Process'])
    expect([...r.localProcesses].sort()).toEqual(['LIP_FetchPage', 'LIP_HandleOrder'])
    expect(r.localProcessSteps.map((p) => `${p.name}: ${p.steps.map((s) => s.name)}`).sort()).toEqual(['LIP_FetchPage: CM_SetHasMore', 'LIP_HandleOrder: CM_MarkOrder'])
    expect(r.warnings).toEqual([])
  })

  test('more than one integration process: the first is shown, and Explain, Import and updates say so', async () => {
    const zip = await twoIntegrationProcesses()
    const r = await parse(zip)
    expect(r.integrationProcesses).toEqual(['LIP_FetchPage', 'Integration Process'])
    expect(r.localProcesses).toEqual(['LIP_HandleOrder'])
    expect(r.warnings).toEqual(['The iFlow has 2 integration processes ("LIP_FetchPage", "Integration Process"); only "LIP_FetchPage" is shown as the main flow.'])

    const imported = await importIflow(zip, { fileName: 'two.zip', packageId: 'PilotReference' })
    expect(imported.notes).toContain('Only the integration process "LIP_FetchPage" was imported; not imported: Integration Process')

    expect(specFromParsed(r, { packageId: 'PilotReference' }).blockers).toContain('2 integration processes: LIP_FetchPage, Integration Process (the spec holds one)')
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
