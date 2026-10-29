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

/** Properties of the element (step or start event) named `name` in a built or reference ZIP, without ids and versions */
async function elementProps(zipBuffer, name) {
  const zip = await JSZip.loadAsync(zipBuffer)
  const iflw = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
  const element = iflw.match(new RegExp(`<bpmn2:(callActivity|startEvent) id="[^"]+" name="${name}">[\\s\\S]*?</bpmn2:\\1>`))[0]
  return Object.fromEntries(
    [...element.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)].filter((m) => !/^(cmdVariantUri|componentVersion)$/.test(m[1])).map((m) => [m[1], m[2] ?? ''])
  )
}

describe('Ref_Variables: Content Modifier sources and Write Variables (phase 1a)', () => {
  // test/reference-prompts/Ref_Variables.txt
  const spec = {
    id: 'Ref_Variables',
    name: 'Ref_Variables',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      {
        type: 'contentModifier',
        name: 'CM_SetBody',
        headers: [{ name: 'DummyHeader', type: 'constant', value: 'H1', datatype: 'java.lang.String' }],
        properties: [{ name: 'inputProp', type: 'constant', value: 'P1', datatype: 'java.lang.String' }],
        body: '<root><value>42</value></root>'
      },
      {
        type: 'contentModifier',
        name: 'CM_ReadSources',
        properties: [
          { name: 'p_global', type: 'globalVariable', value: 'DUMMY_GLOBAL_VAR' },
          { name: 'p_local', type: 'localVariable', value: 'DUMMY_LOCAL_VAR' },
          { name: 'p_header', type: 'header', value: 'DummyHeader' },
          { name: 'p_property', type: 'property', value: 'inputProp' },
          { name: 'p_xpath', type: 'xpath', value: '/root/value', datatype: 'java.lang.String' },
          { name: 'p_constant', type: 'constant', value: 'ABC' },
          { name: 'p_expr', type: 'expression', value: '${date:now:yyyy-MM-dd HH:mm:ss}' },
          { name: 'p_param', type: 'constant', value: '{{DummyParam}}', default: 'default-value' }
        ]
      },
      {
        type: 'writeVariables',
        name: 'WV_Variables',
        variables: [
          { name: 'DUMMY_GLOBAL_VAR', type: 'property', value: 'p_constant', global: true },
          { name: 'DUMMY_LOCAL_VAR', type: 'xpath', value: '/root/value', datatype: 'java.lang.String' }
        ]
      }
    ],
    end: { type: 'none' },
    parameters: { DummyParam: 'dummy-value' }
  }
  const NAMES = ['CM_SetBody', 'CM_ReadSources', 'WV_Variables']

  let builtZip, built, reference
  beforeAll(async () => {
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
    built = await parse(builtZip)
    reference = await parse(readRef('Ref_Variables.zip'))
  })

  test('the parsed steps are the same: every row with its source, value, default and data type', () => {
    const steps = (p) => p.steps.filter((s) => NAMES.includes(s.name)).map(({ id, ...rest }) => rest)
    expect(steps(built)).toEqual(steps(reference))
    expect(built.parameters.DummyParam).toBe(reference.parameters.DummyParam)
  })

  test('every property of the three steps is as in the reference (tables included)', async () => {
    for (const name of NAMES) expect([name, await elementProps(builtZip, name)]).toEqual([name, await elementProps(readRef('Ref_Variables.zip'), name)])
  })

  test('the spec validates without errors or warnings it should not have', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors }).toEqual({ valid: true, errors: [] })
    // every value is in the references and confirmed (confirmed-values.json)
    expect(warnings).toEqual([])
  })
})

describe('Ref_Router_Ends: Timer start every 15 minutes (phase 1a; the routers follow in 1b)', () => {
  const spec = {
    id: 'Ref_Router_Ends',
    name: 'Ref_Router_Ends',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'every', minutes: 15 },
    steps: [{ type: 'contentModifier', name: 'CM_SetInput', properties: [{ name: 'routeKey', type: 'constant', value: 'A' }] }],
    end: { type: 'none' }
  }
  const schedule = (props) => Object.fromEntries([...props.scheduleKey.replace(/&lt;/g, '<').replace(/&gt;/g, '>').matchAll(/<row><cell>([^<]*)<\/cell><cell>([^<]*)<\/cell><\/row>/g)].map((m) => [m[1], m[2]]))

  test('parsed as every 15 minutes, like the reference', async () => {
    const built = await parse((await build(spec)).zipBase64)
    const reference = await parse(readRef('Ref_Router_Ends.zip'))
    expect(built.trigger).toEqual({ ...reference.trigger, name: built.trigger.name })
    expect(built.trigger).toMatchObject({ type: 'timer', mode: 'every', minutes: 15 })
  })

  test('the timer properties and the stored schedule are as in the reference', async () => {
    const built = await elementProps(Buffer.from((await build(spec)).zipBase64, 'base64'), 'Start Timer 1')
    const reference = await elementProps(readRef('Ref_Router_Ends.zip'), 'Timer 1')
    const { scheduleKey: a, ...builtRest } = built
    const { scheduleKey: b, ...referenceRest } = reference
    expect(builtRest).toEqual(referenceRest)
    // the newer scheduler's setting is schedule1; the older clock fields keep the template's values
    const [s1, s2] = [schedule(built), schedule(reference)]
    expect(s1.schedule1).toBe(s2.schedule1)
    expect(Object.keys(s1).sort()).toEqual(Object.keys(s2).sort())
  })
})
