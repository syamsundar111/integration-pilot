/**
 * Offline regression tests against the reference exports (srv/iflow-builder/reference/Ref_*.zip): for
 * each part the builder supports, a spec written from the reference's prompt (test/reference-prompts/)
 * is built, parsed back and compared with the parsed reference. A difference means the builder writes
 * something other than what the CPI editor saved.
 */
const { build } = require('../srv/iflow-builder/builder')
const { parse } = require('../srv/iflow-builder/parser')
const JSZip = require('jszip')
const { readRef } = require('./helpers')

// differ by design: adapter version (templates: 1.22.0, Ref_Receivers: 1.22.1) and the receiver names
const IGNORED = /^(TransportProtocolVersion|MessageProtocolVersion|ComponentSWCVId|cmdVariantUri|system)$/

/** The HTTP receivers of a parsed iFlow by step name: { name: { property: value } } */
function receivers(parsed, names) {
  const out = {}
  for (const s of parsed.steps.filter((x) => names.includes(x.name))) {
    const adapter = parsed.adapters.find((a) => a.source === s.id)
    out[s.name] = Object.fromEntries(Object.entries(adapter.settings).filter(([k]) => !IGNORED.test(k)))
  }
  return out
}

/**
 * parameters.propdef references of the given parameters: { param: { field, label, category } }; the category
 * without the receiver's name (RCV_OAuth.Receiver.Auth -> .Receiver.Auth), the field without the adapter version
 */
async function paramReferences(zipBuffer, params) {
  const zip = await JSZip.loadAsync(zipBuffer)
  const propdef = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('parameters.propdef'))).async('string')
  const iflw = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
  const systems = [...iflw.matchAll(/<key>system<\/key>\s*<value>([^<]*)<\/value>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)
  const out = {}
  for (const [, category, id, label, key] of propdef.matchAll(/<reference attribute_category="([^"]+)" attribute_id="([^"]+)" attribute_uilabel="([^"]+)" param_key="([^"]+)"\/>/g)) {
    if (!params.includes(key)) continue
    const system = systems.find((sys) => category.startsWith(sys))
    out[key] = { field: id.replace(/\/version::[^/]+\//, '/'), label, category: category.slice(system.length) }
  }
  return out
}

describe('Ref_Receivers: HTTP receivers (authentication, proxy, timeout)', () => {
  const HTTP = ['RR_Basic', 'RR_OAuth', 'RR_OnPrem']
  // test/reference-prompts/Ref_Receivers.txt, steps 2-5 (the SOAP and Mail receivers come in later phases)
  const spec = {
    id: 'Ref_Receivers',
    name: 'Ref_Receivers',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      { type: 'contentModifier', name: 'CM_Prepare', headers: [{ name: 'Content-Type', type: 'constant', value: 'application/json', datatype: 'java.lang.String' }], body: '{"test": true}' },
      { type: 'requestReplyHttp', name: 'RR_Basic', system: 'RCV_Basic', url: '{{BasicAddress}}', method: 'GET', authType: 'Basic', credentialName: '{{BasicCredential}}', timeout: 60000 },
      {
        type: 'requestReplyHttp',
        name: 'RR_OAuth',
        system: 'RCV_OAuth',
        url: '{{RR_OAuth_Address}}',
        method: 'POST',
        authType: 'OAuth2 Client Credentials',
        credentialName: '{{RR_OAuth_CredentialName}}'
      },
      {
        type: 'requestReplyHttp',
        name: 'RR_OnPrem',
        system: 'RCV_OnPrem',
        url: 'http://s4dummy:8000/sap/bc/dummy',
        method: 'POST',
        authType: 'Basic',
        credentialName: 'DUMMY_ONPREM_CRED',
        proxyType: 'On-Premise',
        locationId: '{{RR_OnPrem_LocationId}}'
      }
    ],
    end: { type: 'none' },
    parameters: {
      BasicAddress: 'https://basic.example.com/api/items',
      BasicCredential: 'DUMMY_BASIC_CRED',
      RR_OAuth_Address: 'https://oauth.example.com/api/items',
      RR_OAuth_CredentialName: 'DUMMY_OAUTH_CRED',
      RR_OnPrem_LocationId: 'DUMMY_LOC'
    }
  }

  let built, reference, builtZip
  beforeAll(async () => {
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
    built = await parse(builtZip)
    reference = await parse(readRef('Ref_Receivers.zip'))
  })

  test('every property of the three HTTP receivers is as in the reference', () => {
    const want = receivers(reference, HTTP)
    expect(Object.keys(want)).toEqual(HTTP)
    expect(receivers(built, HTTP)).toEqual(want)
  })

  test('the parsed steps carry the same settings', () => {
    const fields = (p) => p.steps.filter((s) => HTTP.includes(s.name)).map(({ id, system, ...rest }) => rest)
    expect(fields(built)).toEqual(fields(reference))
    expect(fields(built).find((s) => s.name === 'RR_OnPrem')).toMatchObject({ authType: 'Basic', credentialAlias: 'DUMMY_ONPREM_CRED', proxyType: 'On-Premise', locationId: '{{RR_OnPrem_LocationId}}' })
  })

  test('the externalized fields have the same parameters, defaults and propdef references (step c2)', async () => {
    const params = ['BasicAddress', 'BasicCredential', 'RR_OAuth_Address', 'RR_OAuth_CredentialName', 'RR_OnPrem_LocationId']
    for (const p of params) expect(built.parameters[p]).toBe(reference.parameters[p])
    const want = await paramReferences(readRef('Ref_Receivers.zip'), params)
    expect(Object.keys(want).sort()).toEqual([...params].sort())
    expect(await paramReferences(builtZip, params)).toEqual(want)
  })

  test('the content modifier before them is as in the reference', () => {
    const cm = (p) => p.steps.find((s) => s.name === 'CM_Prepare')
    expect(cm(built)).toMatchObject({ headers: cm(reference).headers, body: cm(reference).body })
  })
})

describe('allowed values (templates/reference-values.json)', () => {
  test('are the values of the current reference exports (run npm run templates:derive after changing one)', async () => {
    const { referenceValues } = require('../srv/iflow-builder/derive-templates')
    expect(await referenceValues()).toEqual(require('../srv/iflow-builder/templates/reference-values.json'))
  })
})
