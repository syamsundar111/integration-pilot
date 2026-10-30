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

describe('Ref_Router_Ends: routers, routes, end events and the join (phase 1b)', () => {
  // test/reference-prompts/Ref_Router_Ends.txt in the agreed branch format
  const cm = (name, prop, value) => ({ type: 'contentModifier', name, properties: [{ name: prop, type: 'constant', value, datatype: 'java.lang.String' }] })
  const spec = {
    id: 'Ref_Router_Ends',
    name: 'Ref_Router_Ends',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'every', minutes: 15 },
    steps: [
      { ...cm('CM_SetInput', 'routeKey', 'A'), body: '<root><type>X</type></root>' },
      {
        type: 'router',
        name: 'RT_NonXml',
        expressionType: 'NonXML',
        routes: [
          { name: 'R_Continue', condition: "${property.routeKey} = 'A'" },
          { name: 'R_Escalate', condition: "${property.routeKey} = 'B'", end: { event: 'escalation', name: 'EE_Route', category: 'RoutingConditionNotMet' } },
          { name: 'R_Default', default: true, end: { event: 'error', name: 'ERR_Route' } }
        ]
      },
      {
        type: 'router',
        name: 'RT_Xml',
        expressionType: 'XML',
        routes: [
          { name: 'R_TypeX', condition: "/root/type = 'X'", steps: [cm('CM_RouteX', 'route', 'X')] },
          { name: 'R_Other', default: true, steps: [cm('CM_RouteOther', 'route', 'OTHER')] }
        ]
      },
      cm('CM_Join', 'joined', 'true')
    ],
    end: { type: 'none' },
    exceptionSubprocess: {
      name: 'ESP_Errors',
      steps: [{ type: 'contentModifier', name: 'CM_ErrorInfo', properties: [{ name: 'errorText', type: 'expression', value: '${exception.message}', datatype: 'java.lang.String' }] }],
      end: { event: 'escalation', name: 'EE_Exception', category: 'Others' }
    }
  }
  const IGLOW = ['Set log headers'] // iGlow's extra step in the reference (CLAUDE.md: ignore)

  let builtZip, built, reference
  beforeAll(async () => {
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
    built = await parse(builtZip)
    reference = await parse(readRef('Ref_Router_Ends.zip'))
  })

  /** The routed structure without ids and iGlow extras, routes in evaluation order */
  const structure = (p) => JSON.parse(JSON.stringify(p.routed.steps.filter((s) => !IGLOW.includes(s.name)), (k, v) => (k === 'id' ? undefined : v)))

  test('routes keep their order: the spec order in the built router, the prompt order in the reference (default last)', async () => {
    const order = (p) => p.routed.steps.filter((s) => s.routes).map((s) => s.routes.map((r) => r.name))
    expect(order(reference)).toEqual([
      ['R_Continue', 'R_Escalate', 'R_Default'],
      ['R_TypeX', 'R_Other']
    ])
    expect(order(built)).toEqual(spec.steps.filter((s) => s.routes).map((s) => s.routes.map((r) => r.name)))
    // the built router lists its routes in the spec order twice: its outgoing flows and the flows themselves
    const zip = await JSZip.loadAsync(builtZip)
    const xml = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
    const flowName = (id) => xml.match(new RegExp(`<bpmn2:sequenceFlow id="${id}" name="([^"]+)"`))[1]
    for (const [, id, body] of xml.matchAll(/<bpmn2:exclusiveGateway[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn2:exclusiveGateway>/g)) {
      const outgoing = [...body.matchAll(/<bpmn2:outgoing>([^<]+)</g)].map((m) => flowName(m[1]))
      const flows = [...xml.matchAll(new RegExp(`<bpmn2:sequenceFlow id="[^"]+" name="([^"]+)" sourceRef="${id}"`, 'g'))].map((m) => m[1])
      expect(flows).toEqual(outgoing)
      expect(order(built)).toContainEqual(outgoing)
    }
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('the same routers, routes, conditions, defaults, route steps, ends and join as the reference', () => {
    expect(structure(built)).toEqual(structure(reference))
    expect(built.routed.end).toEqual({ ...reference.routed.end, name: 'End' })
  })

  test('the exception subprocess ends with the Escalation End EE_Exception, category Others', () => {
    expect(built.exceptionSubprocess).toMatchObject({ end: 'escalation', endName: 'EE_Exception', endCategory: 'Others', steps: [{ name: 'CM_ErrorInfo' }] })
    expect(reference.exceptionSubprocess).toMatchObject({ end: 'escalation', endName: 'EE_Exception', endCategory: 'Others' })
  })

  test('escalation categories: RoutingConditionNotMet on EE_Route, as stored in the reference', () => {
    const route = (p) => p.routed.steps.find((s) => s.name === 'RT_NonXml').routes.find((r) => r.name === 'R_Escalate')
    expect(route(built).end).toEqual({ kind: 'escalation', name: 'EE_Route', category: 'RoutingConditionNotMet' })
    expect(route(reference).end).toEqual(route(built).end)
  })

  /** Properties of every gateway, route and end event, by name (ids, versions and the empty iGlow default route aside) */
  async function branchProps(zipBuffer) {
    const zip = await JSZip.loadAsync(zipBuffer)
    const iflw = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
    const out = {}
    for (const [el, tag, name] of iflw.matchAll(/<bpmn2:(exclusiveGateway|sequenceFlow|endEvent)\b[^>]*\bname="([^"]+)"[^>]*[^/]>[\s\S]*?<\/bpmn2:\1>/g)) {
      if (tag === 'sequenceFlow' && !/GatewayRoute/.test(el)) continue
      const props = Object.fromEntries([...el.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)].map((m) => [m[1], m[2] ?? '']))
      const definition = el.match(/<bpmn2:(\w+EventDefinition)/)?.[1] || null
      const condition = el.match(/<bpmn2:conditionExpression[^>]*>([^<]*)</)?.[1] ?? null
      out[`${tag} ${name}`] = { props, definition, condition, isDefault: tag === 'exclusiveGateway' ? !!el.match(/default="/) : undefined }
    }
    return out
  }

  test('every property of the routers, routes and end events is as in the reference', async () => {
    const want = await branchProps(readRef('Ref_Router_Ends.zip'))
    // decision 1b/1: the expression type is written on every route, as on R_Other; iGlow left it empty on R_Default
    expect(want['sequenceFlow R_Default'].props.expressionType).toBe('')
    want['sequenceFlow R_Default'].props.expressionType = 'NonXML'
    expect(await branchProps(builtZip)).toEqual(want)
  })

  test('an update of the reference gives the same spec back (no blockers)', () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const r = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(r.blockers).toEqual([])
    const withoutIglow = { ...r.spec, steps: r.spec.steps.filter((s) => !IGLOW.includes(s.name)) }
    expect(withoutIglow.steps).toEqual(spec.steps) // routes in the same order
    expect(withoutIglow.exceptionSubprocess).toEqual({ ...spec.exceptionSubprocess, name: 'Exception Subprocess 1' })
  })
})

describe('Ref_Structure: splitters, gather, process calls and local processes (phase 2)', () => {
  // test/reference-prompts/Ref_Structure.txt in the agreed format
  const spec = {
    id: 'Ref_Structure',
    name: 'Ref_Structure',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      { type: 'contentModifier', name: 'CM_SetBody', body: '<orders><order><id>1</id></order><order><id>2</id></order></orders>' },
      { type: 'splitter', name: 'ITSPL_Orders', kind: 'iterating', expression: '//order', stopOnException: false },
      { type: 'processCall', name: 'PC_HandleOrder', process: 'LIP_HandleOrder' },
      { type: 'gather', name: 'GA_Orders', source: '//order', target: '/orders' },
      { type: 'processCall', name: 'LPC_FetchPages', process: 'LIP_FetchPage', loop: { condition: "${property.hasMore} = 'true'", max: 5 } },
      { type: 'splitter', name: 'GSPL_Orders', kind: 'general', expression: '/orders/order', streaming: false, stopOnException: true }
    ],
    end: { type: 'none' },
    localProcesses: [
      { name: 'LIP_FetchPage', steps: [{ type: 'contentModifier', name: 'CM_SetHasMore', properties: [{ name: 'hasMore', type: 'constant', value: 'false', datatype: 'java.lang.String' }] }] },
      { name: 'LIP_HandleOrder', steps: [{ type: 'contentModifier', name: 'CM_MarkOrder', headers: [{ name: 'orderId', type: 'xpath', value: '/order/id', datatype: 'java.lang.String' }] }] }
    ]
  }
  const STEPS = ['ITSPL_Orders', 'PC_HandleOrder', 'GA_Orders', 'LPC_FetchPages', 'GSPL_Orders']

  let builtZip, built, reference
  beforeAll(async () => {
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
    built = await parse(builtZip)
    reference = await parse(readRef('Ref_Structure.zip'))
  })

  /** Parsed steps without ids; a process call's processId differs by design (generated ids) */
  const steps = (list) => JSON.parse(JSON.stringify(list, (k, v) => (k === 'id' || k === 'processId' ? undefined : v)))

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('the same main line as the reference: splitters, process calls with their process and loop, the gather', () => {
    expect(steps(built.steps)).toEqual(steps(reference.steps))
    expect(built.linear).toBe(true)
  })

  test('the same local processes with their steps', () => {
    const locals = (p) => steps(p.localProcessSteps).sort((a, b) => a.name.localeCompare(b.name))
    expect(locals(built)).toEqual(locals(reference))
    expect(built.localProcesses.sort()).toEqual(reference.localProcesses.sort())
  })

  test('every property of the splitters, the gather and the process calls is as in the reference', async () => {
    for (const name of STEPS) {
      const want = await elementProps(readRef('Ref_Structure.zip'), name)
      const have = await elementProps(builtZip, name)
      // generated ids: the called process and the loop characteristics
      for (const p of [want, have]) for (const k of ['processId', 'loopId']) if (k in p) p[k] = '(id)'
      expect([name, have]).toEqual([name, want])
    }
  })

  test('each process call refers to its local process by id, and the loop is as in the reference', async () => {
    const zip = await JSZip.loadAsync(builtZip)
    const xml = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
    const processId = (name) => xml.match(new RegExp(`<bpmn2:process id="([^"]+)" name="${name}">`))[1]
    expect(built.steps.find((s) => s.name === 'PC_HandleOrder').processId).toBe(processId('LIP_HandleOrder'))
    expect(built.steps.find((s) => s.name === 'LPC_FetchPages').processId).toBe(processId('LIP_FetchPage'))
    expect(processId('Integration Process')).toBe('Process_1')
    const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(ids.filter((v, i) => ids.indexOf(v) !== i)).toEqual([]) // no id twice
  })

  test('an update of the reference gives the same spec back (no blockers)', () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const r = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(r.blockers).toEqual([])
    expect(r.spec.steps).toEqual(spec.steps)
    expect(r.spec.localProcesses).toEqual(spec.localProcesses)
  })

  test('Import gives the same steps and local processes (the iGlow exception subprocess left out)', async () => {
    const { importIflow } = require('../srv/iflow-builder/import')
    const r = await importIflow(readRef('Ref_Structure.zip'), { fileName: 'Ref_Structure.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 0 })
    expect(r.spec.steps).toEqual(spec.steps)
    expect(r.spec.localProcesses).toEqual(spec.localProcesses)
  })
})

describe('Ref_Receivers: SOAP 1.x and Mail receivers (phase 3)', () => {
  const STEPS = ['RR_Soap', 'SND_Alert']
  // test/reference-prompts/Ref_Receivers.txt, steps 6 and 7
  const soap = { type: 'requestReplySoap', name: 'RR_Soap', system: 'RCV_Soap', url: '{{RR_Soap_Address}}', authType: 'Basic', credentialName: 'DUMMY_SOAP_CRED', proxyType: 'On-Premise', locationId: 'DUMMY_LOC' }
  const mail = { type: 'sendMail', name: 'SND_Alert', system: 'RCV_Mail', server: '{{Mail_Server}}', credentialName: '{{Mail_Credential}}', from: 'noreply@example.com', to: '{{Mail_To}}', subject: 'Dummy alert' }
  const spec = {
    id: 'Ref_Receivers',
    name: 'Ref_Receivers',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'once' },
    steps: [soap, mail],
    end: { type: 'none' },
    parameters: { RR_Soap_Address: 'http://s4dummy:8000/sap/bc/srt/dummy', Mail_Server: 'smtp.example.com:587', Mail_Credential: 'DUMMY_MAIL_CRED', Mail_To: 'alerts@example.com' }
  }
  const params = Object.keys(spec.parameters)

  let builtZip, built, reference
  beforeAll(async () => {
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
    built = await parse(builtZip)
    reference = await parse(readRef('Ref_Receivers.zip'))
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('every property of the SOAP and Mail receivers is as in the reference', () => {
    const want = receivers(reference, STEPS)
    expect(Object.keys(want)).toEqual(STEPS)
    expect(receivers(built, STEPS)).toEqual(want)
  })

  test('the steps themselves are as in the reference: a Request Reply and a Send step', async () => {
    for (const name of STEPS) {
      const zip = await JSZip.loadAsync(builtZip)
      const xml = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
      const refZip = await JSZip.loadAsync(readRef('Ref_Receivers.zip'))
      const refXml = await refZip.file(Object.keys(refZip.files).find((f) => f.endsWith('.iflw'))).async('string')
      const props = (x) => [...x.match(new RegExp(`<bpmn2:serviceTask id="[^"]+" name="${name}">[\\s\\S]*?</bpmn2:serviceTask>`))[0].matchAll(/<key>([^<]*)<\/key>\s*<value>([^<]*)</g)].map((m) => [m[1], m[2]])
      expect(props(xml)).toEqual(props(refXml))
    }
  })

  test('the parsed steps carry the same settings', () => {
    const fields = (p) => p.steps.filter((s) => STEPS.includes(s.name)).map(({ id, system, ...rest }) => rest)
    expect(fields(built)).toEqual(fields(reference))
  })

  test('the externalized fields have the same parameters, defaults and propdef references', async () => {
    for (const p of params) expect(built.parameters[p]).toBe(reference.parameters[p])
    const want = await paramReferences(readRef('Ref_Receivers.zip'), params)
    expect(Object.keys(want).sort()).toEqual([...params].sort())
    expect(await paramReferences(builtZip, params)).toEqual(want)
  })

  test('an update of the reference keeps them (no blockers); Import holds them without placeholders', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const r = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(r.blockers).toEqual([])
    const of = (sp) => sp.steps.filter((s) => STEPS.includes(s.name)).map(({ system, ...s }) => s)
    const without = [soap, mail].map(({ system, ...s }) => s)
    expect(of(r.spec)).toEqual(without)
    const imported = await importIflow(readRef('Ref_Receivers.zip'), { fileName: 'Ref_Receivers.zip', packageId: 'PilotReference' })
    expect(imported).toMatchObject({ valid: true, errors: [], placeholders: 0 })
    expect(of(imported.spec)).toEqual(without)
    expect(imported.spec.parameters).toMatchObject(spec.parameters)
  })
})
