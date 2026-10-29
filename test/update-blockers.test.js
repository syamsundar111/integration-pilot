/**
 * Updates never silently drop what the spec cannot hold (full review #8): a Cloud Connector proxy,
 * its location ID, timeouts and other receiver/sender settings, or a second exception subprocess.
 * getIflowSpec reports them as blockers (editable: false) instead.
 */
const JSZip = require('jszip')
const { build } = require('../srv/iflow-builder/builder')
const { parse } = require('../srv/iflow-builder/parser')
const { specFromParsed } = require('../srv/iflow-builder/to-spec')
const { baseSpec } = require('./helpers')

const IFLW = /\.iflw$/
const spec = baseSpec({
  id: 'Blocker_Flow',
  steps: [{ type: 'requestReplyHttp', name: 'Call ERP', system: 'ERP', url: 'https://erp.example.com/api', method: 'GET', authType: 'None' }],
  exceptionSubprocess: { steps: [{ type: 'contentModifier', name: 'Set Error', properties: [{ name: 'E', type: 'expression', value: '${exception.message}' }] }] }
})

/** Builds the spec, patches the .iflw text (and adds parameters to parameters.prop), parses the result back like an update would */
async function readBack(patch = (x) => x, parameters = {}) {
  const zip = await JSZip.loadAsync(Buffer.from((await build(spec)).zipBase64, 'base64'))
  const file = Object.keys(zip.files).find((f) => IFLW.test(f))
  zip.file(file, patch(await zip.file(file).async('string')))
  const prop = Object.keys(zip.files).find((f) => f.endsWith('parameters.prop'))
  zip.file(prop, (await zip.file(prop).async('string')) + Object.entries(parameters).map(([k, v]) => `${k}=${v}\n`).join(''))
  return specFromParsed(await parse(await zip.generateAsync({ type: 'nodebuffer' })), { packageId: spec.packageId })
}
const setting = (xml, key, value) => xml.replace(new RegExp(`(<key>${key}</key>\\s*)(<value>[^<]*</value>|<value/>)`), `$1<value>${value}</value>`)

describe('update blockers', () => {
  test("the builder's own output has none", async () => {
    expect((await readBack()).blockers).toEqual([])
  })

  test('a Cloud Connector receiver with location ID, authentication and a longer timeout is kept by an update', async () => {
    const r = await readBack((x) =>
      [
        ['proxyType', 'sapcc'],
        ['locationID', 'LOC1'],
        ['httpRequestTimeout', '600000'],
        ['authenticationMethod', 'Basic'],
        ['credentialName', 'ERP_BASIC_USER']
      ].reduce((xml, [k, v]) => setting(xml, k, v), x)
    )
    expect(r.blockers).toEqual([])
    expect(r.spec.steps[0]).toEqual({
      type: 'requestReplyHttp',
      name: 'Call ERP',
      system: 'ERP',
      url: 'https://erp.example.com/api',
      method: 'GET',
      authType: 'Basic',
      credentialName: 'ERP_BASIC_USER',
      proxyType: 'On-Premise',
      locationId: 'LOC1',
      timeout: 600000
    })
  })

  test('a credential name and location ID given as parameters are kept as parameters (step c2)', async () => {
    const r = await readBack((x) =>
      [
        ['proxyType', 'sapcc'],
        ['locationID', '{{ErpLocation}}'],
        ['authenticationMethod', 'Basic'],
        ['credentialName', '{{ErpCredential}}']
      ].reduce((xml, [k, v]) => setting(xml, k, v), x),
      { ErpLocation: 'LOC1', ErpCredential: 'ERP_BASIC_USER' }
    )
    expect(r.blockers).toEqual([])
    expect(r.spec.steps[0]).toMatchObject({ authType: 'Basic', credentialName: '{{ErpCredential}}', proxyType: 'On-Premise', locationId: '{{ErpLocation}}' })
    expect(r.spec.parameters).toMatchObject({ ErpLocation: 'LOC1', ErpCredential: 'ERP_BASIC_USER' })
  })

  test('receiver settings the spec cannot hold are blockers, not silently reset', async () => {
    for (const [patch, blocker] of [
      [(x) => setting(x, 'proxyType', 'manual'), "receiver ERP uses proxy type 'manual', which an update cannot keep"],
      [(x) => setting(x, 'authenticationMethod', 'Client Certificate'), "receiver ERP uses authentication 'Client Certificate', which an update cannot keep"]
    ]) {
      const r = await readBack(patch)
      expect(r.spec).toBeNull()
      expect(r.blockers).toEqual([expect.stringContaining(blocker)])
    }
  })

  test('Write Variables settings an update would reset are blockers; the rows themselves are kept (phase 1a)', async () => {
    const wvSpec = { ...spec, steps: [...spec.steps, { type: 'writeVariables', name: 'WV', variables: [{ name: 'LAST', type: 'property', value: 'p', global: true }] }] }
    const zip = await JSZip.loadAsync(Buffer.from((await build(wvSpec)).zipBase64, 'base64'))
    const file = Object.keys(zip.files).find((f) => IFLW.test(f))
    const iflw = await zip.file(file).async('string')
    const back = async (xml) => {
      zip.file(file, xml)
      return specFromParsed(await parse(await zip.generateAsync({ type: 'nodebuffer' })), { packageId: spec.packageId })
    }
    const kept = await back(iflw)
    expect(kept.blockers).toEqual([])
    expect(kept.spec.steps.at(-1)).toEqual({ type: 'writeVariables', name: 'WV', variables: [{ name: 'LAST', type: 'property', value: 'p', global: true }] })
    expect((await back(setting(iflw, 'encrypt', 'false'))).blockers).toEqual(["step 2 'WV': encrypt is 'false'; an update would reset it to 'true'"])
  })

  test('sender settings that the update would change are blockers (e.g. CSRF protection on)', async () => {
    const r = await readBack((x) => setting(x, 'xsrfProtection', '1'))
    expect(r.blockers).toEqual([expect.stringMatching(/^sender .*: CSRF protection is '1'; an update would reset it to '0'$/)])
  })

  test('a second exception subprocess is a blocker', async () => {
    const r = await readBack((x) => {
      const sub = x.match(/<bpmn2:subProcess[\s\S]*?<\/bpmn2:subProcess>/)[0]
      let n = 0
      const copy = sub.replace(/id="([^"]+)"/g, (m, id) => `id="${id}_copy${n++}"`).replace(/(sourceRef|targetRef)="([^"]+)"/g, '$1="$2_copy"')
      return x.replace(sub, sub + copy)
    })
    expect(r.blockers).toContain('2 exception subprocesses (the spec holds one; an update would delete the others)')
  })
})

describe('update blockers: JSON <-> XML converter settings (review: an update reset them silently)', () => {
  const convSpec = baseSpec({ id: 'Converter_Flow', steps: [{ type: 'jsonToXml', name: 'To XML' }, { type: 'xmlToJson', name: 'To JSON' }] })
  async function readConv(patch = (x) => x) {
    const zip = await JSZip.loadAsync(Buffer.from((await build(convSpec)).zipBase64, 'base64'))
    const file = Object.keys(zip.files).find((f) => IFLW.test(f))
    zip.file(file, patch(await zip.file(file).async('string')))
    return specFromParsed(await parse(await zip.generateAsync({ type: 'nodebuffer' })), { packageId: convSpec.packageId })
  }

  test("the builder's own converters have no blockers", async () => {
    const r = await readConv()
    expect(r.blockers).toEqual([])
    expect(r.spec.steps.map((s) => s.type)).toEqual(['jsonToXml', 'xmlToJson'])
  })

  test('another root element or suppressed root is a blocker, not reset to the template value', async () => {
    const r = await readConv((x) => setting(setting(x, 'additionalRootElementName', 'Orders'), 'xmlJsonSuppressRootElement', 'true'))
    expect(r.spec).toBeNull()
    expect(r.blockers).toEqual([
      "step 1 'To XML': additionalRootElementName is 'Orders'; an update would reset it to 'root'",
      "step 2 'To JSON': xmlJsonSuppressRootElement is 'true'; an update would reset it to 'false'"
    ])
  })
})

describe('update blockers: Error / Escalation / Terminate ends (review: an update made them Message Ends)', () => {
  // end events of the built iFlow: the main end first, the exception subprocess end second
  const endDef = (which, def) => (xml) => {
    let i = 0
    return xml.replace(/<bpmn2:messageEventDefinition\/>(\s*<\/bpmn2:endEvent>)/g, (m, close) => (i++ === which ? `<bpmn2:${def}/>${close}` : m))
  }

  test('an Error End in the exception subprocess is a blocker', async () => {
    const r = await readBack(endDef(1, 'errorEventDefinition'))
    expect(r.spec).toBeNull()
    expect(r.blockers).toEqual(['the exception subprocess ends with an Error End; an update would make it a Message End (failed messages would show as COMPLETED)'])
  })

  test('an Escalation End of the main flow is a blocker', async () => {
    const r = await readBack(endDef(0, 'escalationEventDefinition'))
    expect(r.blockers).toEqual(['the main flow ends with an Escalation End; an update would make it a Message End'])
  })
})
