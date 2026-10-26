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

/** Builds the spec, patches the .iflw text, parses the result back like an update would */
async function readBack(patch = (x) => x) {
  const zip = await JSZip.loadAsync(Buffer.from((await build(spec)).zipBase64, 'base64'))
  const file = Object.keys(zip.files).find((f) => IFLW.test(f))
  zip.file(file, patch(await zip.file(file).async('string')))
  return specFromParsed(await parse(await zip.generateAsync({ type: 'nodebuffer' })), { packageId: spec.packageId })
}
const setting = (xml, key, value) => xml.replace(new RegExp(`(<key>${key}</key>\\s*)(<value>[^<]*</value>|<value/>)`), `$1<value>${value}</value>`)

describe('update blockers', () => {
  test("the builder's own output has none", async () => {
    expect((await readBack()).blockers).toEqual([])
  })

  test('a Cloud Connector receiver with location ID and a longer timeout is a blocker, not silently reset', async () => {
    const r = await readBack((x) => setting(setting(setting(x, 'proxyType', 'sapcc'), 'locationID', 'LOC1'), 'httpRequestTimeout', '600000'))
    expect(r.spec).toBeNull()
    expect(r.blockers).toEqual([
      "receiver ERP: proxy type is 'sapcc'; an update would reset it to 'default' (Cloud Connector -> Internet)",
      "receiver ERP: Cloud Connector location ID is 'LOC1'; an update would reset it to '(empty)'",
      "receiver ERP: request timeout is '600000'; an update would reset it to '60000'"
    ])
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
