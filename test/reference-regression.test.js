/**
 * Offline regression tests against the reference exports (srv/iflow-builder/reference/Ref_*.zip): for
 * each part the builder supports, a spec written from the reference's prompt (test/reference-prompts/)
 * is built, parsed back and compared with the parsed reference. A difference means the builder writes
 * something other than what the CPI editor saved.
 */
const { build } = require('../srv/iflow-builder/builder')
const { parse } = require('../srv/iflow-builder/parser')
const { readRef } = require('./helpers')

// differ by design: adapter version (templates: 1.22.0, Ref_Receivers: 1.22.1) and the receiver names
const IGNORED = /^(TransportProtocolVersion|MessageProtocolVersion|ComponentSWCVId|cmdVariantUri|system)$/

/** {{Param}} -> its default, so a parameter and its literal value compare equal */
const resolve = (value, params) => String(value ?? '').replace(/\{\{([^}]+)\}\}/g, (m, p) => params[p] ?? m)

/** The HTTP receivers of a parsed iFlow by step name: { name: { property: value } } (parameters resolved) */
function receivers(parsed, names) {
  const out = {}
  for (const s of parsed.steps.filter((x) => names.includes(x.name))) {
    const adapter = parsed.adapters.find((a) => a.source === s.id)
    out[s.name] = Object.fromEntries(Object.entries(adapter.settings).filter(([k]) => !IGNORED.test(k)).map(([k, v]) => [k, resolve(v, parsed.parameters)]))
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
      // the reference externalizes the credential name ({{BasicCredential}}); the spec takes the literal name for now
      { type: 'requestReplyHttp', name: 'RR_Basic', system: 'RCV_Basic', url: '{{BasicAddress}}', method: 'GET', authType: 'Basic', credentialName: 'DUMMY_BASIC_CRED', timeout: 60000 },
      { type: 'requestReplyHttp', name: 'RR_OAuth', system: 'RCV_OAuth', url: '{{RR_OAuth_Address}}', method: 'POST', authType: 'OAuth2 Client Credentials', credentialName: 'DUMMY_OAUTH_CRED' },
      {
        type: 'requestReplyHttp',
        name: 'RR_OnPrem',
        system: 'RCV_OnPrem',
        url: 'http://s4dummy:8000/sap/bc/dummy',
        method: 'POST',
        authType: 'Basic',
        credentialName: 'DUMMY_ONPREM_CRED',
        proxyType: 'On-Premise',
        locationId: 'DUMMY_LOC'
      }
    ],
    end: { type: 'none' },
    parameters: { BasicAddress: 'https://basic.example.com/api/items', RR_OAuth_Address: 'https://oauth.example.com/api/items' }
  }

  let built, reference
  beforeAll(async () => {
    built = await parse((await build(spec)).zipBase64)
    reference = await parse(readRef('Ref_Receivers.zip'))
  })

  test('every property of the three HTTP receivers is as in the reference', () => {
    const want = receivers(reference, HTTP)
    expect(Object.keys(want)).toEqual(HTTP)
    expect(receivers(built, HTTP)).toEqual(want)
  })

  test('the parsed steps carry the same settings', () => {
    const fields = (p) => p.steps.filter((s) => HTTP.includes(s.name)).map(({ id, system, url, credentialAlias, ...rest }) => ({ ...rest, credential: resolve(credentialAlias, p.parameters) }))
    expect(fields(built)).toEqual(fields(reference))
    expect(fields(built).find((s) => s.name === 'RR_OnPrem')).toMatchObject({ authType: 'Basic', credential: 'DUMMY_ONPREM_CRED', proxyType: 'On-Premise', locationId: 'DUMMY_LOC' })
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
