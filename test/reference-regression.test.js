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
  const element = iflw.match(new RegExp(`<bpmn2:(callActivity|startEvent|endEvent|parallelGateway) id="[^"]+" name="${name}">[\\s\\S]*?</bpmn2:\\1>`))[0]
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
      { type: 'splitter', name: 'GSPL_Orders', kind: 'general', expression: '/orders/order', streaming: false, stopOnException: true },
      { type: 'gather', name: 'GA_Combine' }
    ],
    end: { type: 'none' },
    localProcesses: [
      { name: 'LIP_FetchPage', steps: [{ type: 'contentModifier', name: 'CM_SetHasMore', properties: [{ name: 'hasMore', type: 'constant', value: 'false', datatype: 'java.lang.String' }] }] },
      { name: 'LIP_HandleOrder', steps: [{ type: 'contentModifier', name: 'CM_MarkOrder', headers: [{ name: 'orderId', type: 'xpath', value: '/order/id', datatype: 'java.lang.String' }] }] }
    ]
  }
  const STEPS = ['ITSPL_Orders', 'PC_HandleOrder', 'GA_Orders', 'LPC_FetchPages', 'GSPL_Orders', 'GA_Combine']

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

describe('Ref_Mapping: Message Mapping (artifact and inside the iFlow) and XSLT Mapping (phase 4)', () => {
  const STEPS = ['MM_UseArtifact', 'XSLT_Dummy', 'MM_Inline']
  // test/reference-prompts/Ref_Mapping.txt
  const spec = {
    id: 'Ref_Mapping',
    name: 'Ref_Mapping',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      { type: 'contentModifier', name: 'CM_SetBody', body: '<Order><id>1</id><text>Test</text></Order>' },
      { type: 'messageMapping', name: 'MM_UseArtifact', mapping: 'MM_DummyOrderToNotif' },
      { type: 'xsltMapping', name: 'XSLT_Dummy', file: 'DummyTransform.xsl' },
      { type: 'messageMapping', name: 'MM_Inline', file: 'MM_Inline_OrderToNotif.mmap', schemas: ['DummyNotif.xsd', 'DummyOrder.xsd'] }
    ],
    end: { type: 'none' }
  }

  let builtZip, built, reference, attachments
  beforeAll(async () => {
    reference = await parse(readRef('Ref_Mapping.zip'))
    attachments = Object.fromEntries(reference.resourceFiles.map((f) => [f.fileName, f.content]))
    builtZip = Buffer.from((await build(spec, { attachments })).zipBase64, 'base64')
    built = await parse(builtZip)
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec, { attachments: Object.keys(attachments) })
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('the inline mapping stores both field mappings and names its schemas', () => {
    const mmap = attachments['MM_Inline_OrderToNotif.mmap']
    expect(mmap).toMatch(/<brick gid="0" path="\/Notification\/externalId" type="Dst">[\s\S]*?<brick gid="0" path="\/Order\/id" type="Src">/)
    expect(mmap).toMatch(/<brick gid="0" path="\/Notification\/shortText" type="Dst">[\s\S]*?<brick gid="0" path="\/Order\/text" type="Src">/)
    expect(reference.steps.find((s) => s.name === 'MM_Inline').schemas.sort()).toEqual(['DummyNotif.xsd', 'DummyOrder.xsd'])
  })

  test('every property of the mapping steps is as in the reference', async () => {
    for (const name of STEPS) expect([name, await elementProps(builtZip, name)]).toEqual([name, await elementProps(readRef('Ref_Mapping.zip'), name)])
  })

  test('the same parsed steps and the same mapping files in the same places', () => {
    const steps = (p) => JSON.parse(JSON.stringify(p.steps.filter((s) => STEPS.includes(s.name)), (k, v) => (k === 'id' ? undefined : v)))
    expect(steps(built)).toEqual(steps(reference))
    const files = (p) => p.resourceFiles.map((f) => [f.path, f.content]).sort()
    expect(files(built)).toEqual(files(reference))
  })

  test('an update of the reference keeps them (no blockers), with the files as resources but not in spec.resources', () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const r = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(r.blockers).toEqual([])
    expect(r.spec.steps.filter((s) => STEPS.includes(s.name))).toEqual(spec.steps.slice(1))
    expect(r.spec.resources).toBeUndefined()
    expect(Object.keys(r.resources).sort()).toEqual(Object.keys(attachments).sort())
  })

  test('Import holds them without placeholders; the files travel as attachments', async () => {
    const { importIflow } = require('../srv/iflow-builder/import')
    const r = await importIflow(readRef('Ref_Mapping.zip'), { fileName: 'Ref_Mapping.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 0 })
    expect(r.spec.steps.filter((s) => STEPS.includes(s.name))).toEqual(spec.steps.slice(1))
    expect(r.spec.resources).toBeUndefined()
    for (const f of Object.keys(attachments)) expect(r.attachments[f]).toBe(attachments[f])
  })
})

describe('Ref_Multicast: Parallel and Sequential Multicast, Join and the Gather after it (phase 9)', () => {
  const GATEWAYS = ['MC_Parallel', 'JN_Parallel', 'GA_Parallel', 'MC_Sequential', 'JN_Sequential', 'GA_Sequential', 'GA_Items']
  const prop = (name, value) => ({ name, type: 'constant', value, datatype: 'java.lang.String' })
  // test/reference-prompts/Ref_Multicast.txt, without RT_Item: CPI refuses a router between a splitter and its gather
  const spec = {
    id: 'Ref_Multicast',
    name: 'Ref_Multicast',
    packageId: 'PilotReference',
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      { type: 'contentModifier', name: 'CM_SetBody', properties: [prop('stop', 'false')], body: '<orders><order><id>1</id><type>A</type></order><order><id>2</id><type>B</type></order></orders>' },
      {
        type: 'multicast',
        name: 'MC_Parallel',
        mode: 'parallel',
        join: 'JN_Parallel',
        branches: [
          { name: 'Branch 1', steps: [{ type: 'contentModifier', name: 'CM_BranchA', properties: [prop('branch', 'A')] }] },
          {
            name: 'Branch 2',
            steps: [
              {
                type: 'router',
                name: 'RT_Branch',
                expressionType: 'NonXML',
                routes: [{ name: 'R_Stop', condition: "${property.stop} = 'true'", end: { event: 'message', name: 'End_Stop' } }, { name: 'R_Go', default: true }]
              },
              { type: 'contentModifier', name: 'CM_BranchB', properties: [prop('branch', 'B')] }
            ]
          }
        ]
      },
      { type: 'gather', name: 'GA_Parallel' },
      {
        type: 'multicast',
        name: 'MC_Sequential',
        mode: 'sequential',
        join: 'JN_Sequential',
        branches: [
          { name: 'Branch 1', steps: [{ type: 'contentModifier', name: 'CM_SeqA', properties: [prop('seq', 'A')] }] },
          { name: 'Branch 2', steps: [{ type: 'splitter', name: 'ITSPL_Items', kind: 'iterating', expression: '//order', stopOnException: false }, { type: 'gather', name: 'GA_Items' }] }
        ]
      },
      { type: 'gather', name: 'GA_Sequential' }
    ],
    end: { type: 'none' }
  }
  const noIds = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'id' ? undefined : v)))

  let builtZip, built, reference
  beforeAll(async () => {
    reference = await parse(readRef('Ref_Multicast.zip'))
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
    built = await parse(builtZip)
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('every property of the multicasts, joins and gathers is as in the reference', async () => {
    for (const name of GATEWAYS) {
      const want = await elementProps(readRef('Ref_Multicast.zip'), name)
      const have = await elementProps(builtZip, name)
      // generated flow ids: two rows, in the order of the branches
      for (const p of [want, have]) if (p.routingSequenceTable) p.routingSequenceTable = p.routingSequenceTable.replace(/SequenceFlow_\d+/g, '(flow)')
      expect([name, have]).toEqual([name, want])
    }
  })

  test('the sequential routing table names the flows into its branches, in order', async () => {
    const zip = await JSZip.loadAsync(builtZip)
    const xml = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
    const table = (await elementProps(builtZip, 'MC_Sequential')).routingSequenceTable
    const flows = [...table.matchAll(/SequenceFlow_\d+/g)].map((m) => m[0])
    expect(flows.map((f) => xml.match(new RegExp(`id="${f}" name="([^"]+)"`))[1])).toEqual(['Branch 1', 'Branch 2'])
    const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(ids.filter((v, i) => ids.indexOf(v) !== i)).toEqual([]) // no id twice
  })

  test('the parallel multicast and its first gather parse the same from the reference and the built iFlow', () => {
    const first = (p) => noIds(p.routed.steps.slice(1, 3))
    expect(built.routed.unsupported).toBeUndefined()
    expect(first(built)).toEqual(first(reference))
    expect(reference.routed.steps[1].branches.map((b) => b.name)).toEqual(['Branch 1', 'Branch 2']) // not the outgoing order
    expect(reference.routed.steps[3]).toMatchObject({ type: 'multicast', mode: 'sequential', join: 'JN_Sequential' })
  })

  test('an update of the built iFlow gives the same spec back (no blockers)', () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const r = specFromParsed(built, { packageId: 'PilotReference' })
    expect(r.blockers).toEqual([])
    expect(r.spec.steps).toEqual(spec.steps)
  })

  test('the reference itself cannot be updated: its RT_Item is a router before a gather', () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    expect(specFromParsed(reference, { packageId: 'PilotReference' }).blockers.join()).toMatch(/CPI does not accept a router between a splitter and its gather/)
  })

  test('routes that join again in a branch: Import makes the router a placeholder, an update is blocked', async () => {
    const { importIflow } = require('../srv/iflow-builder/import')
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const cm = (name) => ({ type: 'contentModifier', name, properties: [prop('p', 'x')] })
    // the shape the validator now refuses, as an iFlow from the tenant may still have it
    let buildAny
    jest.isolateModules(() => {
      jest.doMock('../srv/iflow-builder/validator', () => ({ ...jest.requireActual('../srv/iflow-builder/validator'), validate: () => ({ valid: true, errors: [], warnings: [] }) }))
      buildAny = require('../srv/iflow-builder/builder').build
    })
    jest.dontMock('../srv/iflow-builder/validator')
    const zip = Buffer.from((await buildAny({ ...spec, steps: [spec.steps[0], { ...spec.steps[1], branches: [spec.steps[1].branches[0], { name: 'Branch 2', steps: [{ type: 'router', name: 'RT_Join', expressionType: 'NonXML', routes: [{ name: 'R_A', condition: "${property.stop} = 'a'", steps: [cm('CM_A')] }, { name: 'R_Go', default: true }] }, cm('CM_After')] }] }, spec.steps[2]] })).zipBase64, 'base64')
    const parsed = await parse(zip)
    expect(specFromParsed(parsed, { packageId: 'PilotReference' }).blockers.join()).toMatch(/routes 'R_A', 'R_Go' all continue/)
    const r = await importIflow(zip, { fileName: 'Join.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 1 })
    const branch = r.spec.steps[1].branches[1].steps
    expect(branch.map((s) => s.name)).toEqual(['RT_Join', 'CM_After'])
    expect(branch[0].description).toMatch(/^REPLACE WITH Router 'RT_Join' whose routes join again in a multicast branch, which CPI does not accept \(R_A .*CM_A; R_Go: no steps\)/)
  })

  test('Import keeps the multicasts; the split with a router in a branch becomes placeholders', async () => {
    const { importIflow } = require('../srv/iflow-builder/import')
    const r = await importIflow(readRef('Ref_Multicast.zip'), { fileName: 'Ref_Multicast.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 2 })
    expect(r.spec.steps.slice(0, 3)).toEqual(spec.steps.slice(0, 3))
    const branch = r.spec.steps[3].branches[1].steps
    expect(branch.map((s) => s.name)).toEqual(['ITSPL_Items', 'RT_Item', 'GA_Items'])
    expect(branch[0].description).toMatch(/^REPLACE WITH Iterating Splitter 'ITSPL_Items' \(\/\/order\) without a gather in its branch/)
    expect(branch[2].description).toMatch(/^REPLACE WITH Gather 'GA_Items' \(combine\) after a router in the split; move the routing into a local process/)
  })
})

describe('Ref_Sender_HTTPS: the HTTP error response (phase 5)', () => {
  // test/reference-prompts/Ref_Sender_HTTPS.txt, without iGlow's "Set log headers"
  const prop = (name, value) => ({ name, type: 'constant', value, datatype: 'java.lang.String' })
  const spec = {
    id: 'Ref_Sender_HTTPS',
    name: 'Ref_Sender_HTTPS',
    packageId: 'PilotReference',
    trigger: { type: 'httpsSender', address: '/dummy/orders' },
    steps: [{ type: 'contentModifier', name: 'CM_Mark', properties: [prop('iFlowName', 'Ref_Sender_HTTPS')] }],
    end: { type: 'none' },
    exceptionSubprocess: {
      steps: [{ type: 'contentModifier', name: 'CM_ErrorResponse', headers: [prop('CamelHttpResponseCode', '500'), prop('Content-Type', 'application/json')], body: '{"error": "${exception.message}"}' }],
      end: { event: 'message', name: 'Error End' }
    }
  }
  const endKind = async (zipBuffer, name) => {
    const zip = await JSZip.loadAsync(zipBuffer)
    const iflw = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
    return iflw.match(new RegExp(`<bpmn2:endEvent id="[^"]+" name="${name}">[\\s\\S]*?</bpmn2:endEvent>`))[0].match(/<bpmn2:(\w+EventDefinition)/)[1]
  }
  let builtZip
  beforeAll(async () => {
    builtZip = Buffer.from((await build(spec)).zipBase64, 'base64')
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('CM_ErrorResponse and the Message End of the exception subprocess are as in the reference', async () => {
    const ref = readRef('Ref_Sender_HTTPS.zip')
    expect(await elementProps(builtZip, 'CM_ErrorResponse')).toEqual(await elementProps(ref, 'CM_ErrorResponse'))
    expect(await elementProps(builtZip, 'Error End')).toEqual(await elementProps(ref, 'Error End'))
    expect(await endKind(builtZip, 'Error End')).toBe('messageEventDefinition')
    expect(await endKind(ref, 'Error End')).toBe('messageEventDefinition')
  })
})

describe('Ref_Sender_SOAP: the SOAP sender (phase 5)', () => {
  // test/reference-prompts/Ref_Sender_SOAP.txt, without iGlow's "Set log headers" and empty exception subprocess
  const spec = {
    id: 'Ref_Sender_SOAP',
    name: 'Ref_Sender_SOAP',
    packageId: 'PilotReference',
    trigger: { type: 'soapSender', address: '/dummy/soap' },
    steps: [{ type: 'contentModifier', name: 'CM_Mark', properties: [{ name: 'iFlowName', type: 'constant', value: 'Ref_Sender_SOAP', datatype: 'java.lang.String' }] }],
    end: { type: 'none' }
  }
  const sender = (parsed) => {
    const a = parsed.adapters.find((x) => x.direction === 'Sender')
    return Object.fromEntries(Object.entries(a.settings).filter(([k]) => !IGNORED.test(k)))
  }
  /** The reference with one sender setting changed (the old export had a WSDL URL) */
  const withSetting = async (key, value) => {
    const zip = await JSZip.loadAsync(readRef('Ref_Sender_SOAP.zip'))
    const file = Object.keys(zip.files).find((f) => f.endsWith('.iflw'))
    const iflw = (await zip.file(file).async('string')).replace(new RegExp(`(<key>${key}</key>\\s*)<value(?:/>|>[^<]*</value>)`), `$1<value>${value}</value>`)
    zip.file(file, iflw)
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  let reference, built
  beforeAll(async () => {
    reference = await parse(readRef('Ref_Sender_SOAP.zip'))
    built = await parse(Buffer.from((await build(spec)).zipBase64, 'base64'))
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('every setting of the sender is as in the reference, the WSDL URL empty', () => {
    expect(sender(built)).toEqual(sender(reference))
    expect(sender(built)).toMatchObject({ serviceDefinition: 'Manual', messageExchangePattern: 'RequestReply', senderAuthType: 'RoleBased', userRole: 'ESBMessaging.send', soapWsdlURL: '', address: '/dummy/soap' })
  })

  test('update and Import keep the SOAP sender', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const update = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(update.blockers).toEqual([])
    expect(update.spec.trigger).toEqual(spec.trigger)
    const imported = await importIflow(readRef('Ref_Sender_SOAP.zip'), { fileName: 'Ref_Sender_SOAP.zip', packageId: 'PilotReference' })
    expect(imported).toMatchObject({ valid: true, errors: [] })
    expect(imported.spec.trigger).toEqual(spec.trigger)
  })

  test('a SOAP sender the builder would change: Import makes it HTTPS with a note, an update is blocked', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    for (const [key, value, text] of [
      ['soapWsdlURL', 'https://dummy.example.com/service?wsdl', /soapWsdlURL is 'https:\/\/dummy\.example\.com\/service\?wsdl' \(the builder writes '\(empty\)'\)/],
      ['address', '{{SOAP_Address}}', /the address is the parameter \{\{SOAP_Address\}\}/]
    ]) {
      const zip = await withSetting(key, value)
      expect(specFromParsed(await parse(zip), { packageId: 'PilotReference' }).blockers.join()).toMatch(text)
      const imported = await importIflow(zip, { fileName: 'Ref_Sender_SOAP.zip', packageId: 'PilotReference' })
      expect(imported.spec.trigger.type).toBe('httpsSender')
      expect(imported.notes.join()).toMatch(text)
    }
  })
})

describe('Ref_Sender_ProcessDirect: the ProcessDirect sender (phase 5)', () => {
  // test/reference-prompts/Ref_Sender_ProcessDirect.txt, without iGlow's "Set log headers" and empty exception subprocess
  const spec = {
    id: 'Ref_Sender_ProcessDirect',
    name: 'Ref_Sender_ProcessDirect',
    packageId: 'PilotReference',
    trigger: { type: 'processDirectSender', address: '/dummy/pd/orders' },
    steps: [{ type: 'contentModifier', name: 'CM_Mark', properties: [{ name: 'iFlowName', type: 'constant', value: 'Ref_Sender_ProcessDirect', datatype: 'java.lang.String' }] }],
    end: { type: 'none' }
  }
  const sender = (parsed) => {
    const a = parsed.adapters.find((x) => x.direction === 'Sender')
    return Object.fromEntries(Object.entries(a.settings).filter(([k]) => !IGNORED.test(k)))
  }
  let reference, built
  beforeAll(async () => {
    reference = await parse(readRef('Ref_Sender_ProcessDirect.zip'))
    built = await parse(Buffer.from((await build(spec)).zipBase64, 'base64'))
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('every setting of the sender is as in the reference', () => {
    expect(sender(built)).toEqual(sender(reference))
    expect(sender(built)).toMatchObject({ ComponentType: 'ProcessDirect', address: '/dummy/pd/orders', direction: 'Sender' })
  })

  test('update and Import keep it; an address given as a parameter makes Import fall back to HTTPS and blocks the update', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const update = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(update.blockers).toEqual([])
    expect(update.spec.trigger).toEqual(spec.trigger)
    const imported = await importIflow(readRef('Ref_Sender_ProcessDirect.zip'), { fileName: 'Ref_Sender_ProcessDirect.zip', packageId: 'PilotReference' })
    expect(imported).toMatchObject({ valid: true, errors: [] })
    expect(imported.spec.trigger).toEqual(spec.trigger)
    const zip = await JSZip.loadAsync(readRef('Ref_Sender_ProcessDirect.zip'))
    const file = Object.keys(zip.files).find((f) => f.endsWith('.iflw'))
    zip.file(file, (await zip.file(file).async('string')).replace(/(<key>address<\/key>\s*)<value>[^<]*<\/value>/, '$1<value>{{PD_Address}}</value>'))
    const withParam = await zip.generateAsync({ type: 'nodebuffer' })
    expect(specFromParsed(await parse(withParam), { packageId: 'PilotReference' }).blockers.join()).toMatch(/the address is the parameter \{\{PD_Address\}\}/)
    const fallback = await importIflow(withParam, { fileName: 'x.zip', packageId: 'PilotReference' })
    expect(fallback.spec.trigger.type).toBe('httpsSender')
    expect(fallback.notes.join()).toMatch(/the ProcessDirect sender \(the address is the parameter \{\{PD_Address\}\}\) was replaced by an HTTPS sender/)
  })
})

describe('Ref_Sender_JMS: the JMS sender (phase 5)', () => {
  // test/reference-prompts/Ref_Sender_JMS.txt, without iGlow's "Set log headers" and empty exception subprocess
  const spec = {
    id: 'Ref_Sender_JMS',
    name: 'Ref_Sender_JMS',
    packageId: 'PilotReference',
    trigger: { type: 'jmsSender', queue: 'DUMMY_QUEUE_IN' },
    steps: [{ type: 'contentModifier', name: 'CM_Mark', properties: [{ name: 'iFlowName', type: 'constant', value: 'Ref_Sender_JMS', datatype: 'java.lang.String' }] }],
    end: { type: 'none' }
  }
  const sender = (parsed) => {
    const a = parsed.adapters.find((x) => x.direction === 'Sender')
    return Object.fromEntries(Object.entries(a.settings).filter(([k]) => !IGNORED.test(k)))
  }
  let reference, built
  beforeAll(async () => {
    reference = await parse(readRef('Ref_Sender_JMS.zip'))
    built = await parse(Buffer.from((await build(spec)).zipBase64, 'base64'))
  })

  test('the spec is valid without warnings', () => {
    const { valid, errors, warnings } = require('../srv/iflow-builder/validator').validate(spec)
    expect({ valid, errors, warnings }).toEqual({ valid: true, errors: [], warnings: [] })
  })

  test('every setting of the sender is as in the reference: the queue, retry, dead-letter queue, access type', () => {
    expect(sender(built)).toEqual(sender(reference))
    expect(sender(built)).toMatchObject({ QueueName_inbound: 'DUMMY_QUEUE_IN', RetryInterval: '1', ExponentialBackoff: '1', MaxRetryInterval: '60', useDeadLetterQueue: '1', AccessType: 'Non-Exclusive', NumberConcurrentProcesses: '1' })
  })

  test('update and Import keep it; a queue given as a parameter makes Import fall back to HTTPS and blocks the update', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const update = specFromParsed(reference, { packageId: 'PilotReference' })
    expect(update.blockers).toEqual([])
    expect(update.spec.trigger).toEqual(spec.trigger)
    const imported = await importIflow(readRef('Ref_Sender_JMS.zip'), { fileName: 'Ref_Sender_JMS.zip', packageId: 'PilotReference' })
    expect(imported).toMatchObject({ valid: true, errors: [] })
    expect(imported.spec.trigger).toEqual(spec.trigger)
    const zip = await JSZip.loadAsync(readRef('Ref_Sender_JMS.zip'))
    const file = Object.keys(zip.files).find((f) => f.endsWith('.iflw'))
    zip.file(file, (await zip.file(file).async('string')).replace(/(<key>QueueName_inbound<\/key>\s*)<value>[^<]*<\/value>/, '$1<value>{{Queue}}</value>'))
    const withParam = await zip.generateAsync({ type: 'nodebuffer' })
    expect(specFromParsed(await parse(withParam), { packageId: 'PilotReference' }).blockers.join()).toMatch(/the queue name is the parameter \{\{Queue\}\}/)
    const fallback = await importIflow(withParam, { fileName: 'x.zip', packageId: 'PilotReference' })
    expect(fallback.spec.trigger.type).toBe('httpsSender')
    expect(fallback.notes.join()).toMatch(/the JMS sender \(the queue name is the parameter \{\{Queue\}\}\) was replaced by an HTTPS sender/)
  })
})

describe('Ref_Sender_SFTP and Ref_Sender_SFTP_UserPw: the SFTP sender (phase 5)', () => {
  // test/reference-prompts/Ref_Sender_SFTP_UserPw.txt; Ref_Sender_SFTP.txt for the public-key variant
  const userPw = {
    id: 'Ref_Sender_SFTP_UserPw',
    name: 'Ref_Sender_SFTP_UserPw',
    packageId: 'PilotReference',
    trigger: { type: 'sftpSender', host: '{{SFTP_Address}}', directory: '{{SFTP_Directory}}', fileName: '{{SFTP_FileName}}', authentication: 'userPassword', credentialName: '{{SFTP_Credential}}', postProcessing: 'move', archiveDirectory: '{{SFTP_ArchiveDirectory}}', minutes: 15 },
    steps: [],
    end: { type: 'none' },
    parameters: { SFTP_Address: 'sftp.example.com:22', SFTP_ArchiveDirectory: '.archive', SFTP_Credential: 'DUMMY_SFTP_CREDENTIAL', SFTP_Directory: '/dummy/in', SFTP_FileName: '*.xml' }
  }
  const publicKey = {
    id: 'Ref_Sender_SFTP',
    name: 'Ref_Sender_SFTP',
    packageId: 'PilotReference',
    trigger: { type: 'sftpSender', host: 'sftp.example.com:22', directory: '/dummy/in', fileName: '*.xml', authentication: 'publicKey', username: 'DUMMY_USER', privateKeyAlias: 'DUMMY_KEY', postProcessing: 'delete', minutes: 15 },
    steps: [{ type: 'contentModifier', name: 'CM_Mark', properties: [{ name: 'iFlowName', type: 'constant', value: 'Ref_Sender_SFTP' }] }],
    end: { type: 'none' }
  }
  const sender = (parsed) => {
    const a = parsed.adapters.find((x) => x.direction === 'Sender')
    return Object.fromEntries(Object.entries(a.settings).filter(([k]) => !IGNORED.test(k)))
  }
  const schedule1 = (scheduleKey) => scheduleKey.match(/<cell>schedule1<\/cell><cell>([^<]*)<\/cell>/)[1]
  const refsOf = async (zipBuffer) => {
    const zip = await JSZip.loadAsync(zipBuffer)
    const propdef = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('parameters.propdef'))).async('string')
    return [...propdef.matchAll(/<reference [^>]*\/>/g)].map((m) => m[0]).sort()
  }
  const builtZip = async (spec) => Buffer.from((await build(spec)).zipBase64, 'base64')
  const { validate } = require('../srv/iflow-builder/validator')

  test('both specs are valid without warnings (every value is confirmed)', () => {
    for (const spec of [userPw, publicKey]) expect(validate(spec)).toMatchObject({ valid: true, errors: [], warnings: [] })
  })

  test('user name/password and Move: every setting as in Ref_Sender_SFTP_UserPw, the scheduler included', async () => {
    expect(sender(await parse(await builtZip(userPw)))).toEqual(sender(await parse(readRef('Ref_Sender_SFTP_UserPw.zip'))))
  })

  test('public key and Delete: every setting as in Ref_Sender_SFTP, except the scheduler rows the CPI editor wrote in UserPw', async () => {
    const built = sender(await parse(await builtZip(publicKey)))
    const reference = sender(await parse(readRef('Ref_Sender_SFTP.zip')))
    const { scheduleKey: a, ...rest } = built
    const { scheduleKey: b, ...referenceRest } = reference
    expect(rest).toEqual(referenceRest)
    expect(schedule1(a)).toBe(schedule1(b)) // every 15 minutes, all day, Etc/GMT
    expect(rest).toMatchObject({ authentication: 'public_key', username: 'DUMMY_USER', privateKeyAlias: 'DUMMY_KEY', credential_name: '', noop: 'delete', proxyType: 'none', readLock: 'none' })
  })

  test('the parameter references of the five fields are as the CPI editor wrote them', async () => {
    expect(await refsOf(await builtZip(userPw))).toEqual(await refsOf(readRef('Ref_Sender_SFTP_UserPw.zip')))
    expect(await refsOf(await builtZip(publicKey))).toEqual([])
  })

  test('update and Import keep both exports, with the parameters as parameters', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    for (const [file, spec] of [['Ref_Sender_SFTP_UserPw.zip', userPw], ['Ref_Sender_SFTP.zip', publicKey]]) {
      const update = specFromParsed(await parse(readRef(file)), { packageId: 'PilotReference' })
      expect(update.blockers).toEqual([])
      expect(update.spec.trigger).toEqual(spec.trigger)
      const imported = await importIflow(readRef(file), { fileName: file, packageId: 'PilotReference' })
      expect(imported).toMatchObject({ valid: true, errors: [] })
      expect(imported.spec.trigger).toEqual(spec.trigger)
    }
    expect((await importIflow(readRef('Ref_Sender_SFTP_UserPw.zip'), { fileName: 'x.zip', packageId: 'PilotReference' })).spec.parameters).toEqual(userPw.parameters)
  })

  test('authentication, post-processing or the scheduler as a parameter: Import falls back to HTTPS, the update is blocked', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const withParam = async (key, re, value) => {
      const zip = await JSZip.loadAsync(readRef('Ref_Sender_SFTP_UserPw.zip'))
      const file = Object.keys(zip.files).find((f) => f.endsWith('.iflw'))
      const before = await zip.file(file).async('string')
      const after = before.replace(new RegExp(`(<key>${key}</key>\\s*)<value>${re}</value>`), `$1<value>${value}</value>`)
      expect(after).not.toBe(before)
      zip.file(file, after)
      return zip.generateAsync({ type: 'nodebuffer' })
    }
    for (const [key, re, value, message] of [
      ['authentication', 'user_password', '{{SFTP_Auth}}', /the authentication is the parameter \{\{SFTP_Auth\}\}/],
      ['noop', 'move', '{{SFTP_PostProcessing}}', /the post-processing is the parameter \{\{SFTP_PostProcessing\}\}/],
      ['scheduleKey', '[^<]*', '{{SFTP_Schedule}}', /the scheduler is a parameter/],
      ['readLock', 'none', 'changed', /readLock is 'changed'/]
    ]) {
      const zip = await withParam(key, re, value)
      expect(specFromParsed(await parse(zip), { packageId: 'PilotReference' }).blockers.join()).toMatch(message)
      const fallback = await importIflow(zip, { fileName: 'x.zip', packageId: 'PilotReference' })
      expect(fallback.spec.trigger.type).toBe('httpsSender')
      expect(fallback.notes.join()).toMatch(/the SFTP sender \(.*\) was replaced by an HTTPS sender/)
    }
  })
})

describe('Ref_Receiver_ProcessDirect: the ProcessDirect receiver (phase 6)', () => {
  // test/reference-prompts/Ref_Receiver_ProcessDirect.txt (Run Once: Simple Schedule, Repeat None)
  const spec = {
    id: 'Ref_Receiver_ProcessDirect',
    name: 'Ref_Receiver_ProcessDirect',
    packageId: 'iglowpackage',
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      { type: 'contentModifier', name: 'CM_Prepare', body: '<Order><id>1</id></Order>' },
      { type: 'requestReplyProcessDirect', name: 'RR_CallOrders', system: 'RCV_PD_Orders', address: '/dummy/pd/orders' }
    ],
    end: { type: 'processDirectReceiver', system: 'RCV_PD_Notify', address: '{{PD_Notify_Address}}' },
    parameters: { PD_Notify_Address: '/dummy/pd/notify' }
  }
  const zipOf = async (s) => Buffer.from((await build(s)).zipBase64, 'base64')
  const flows = async (buf) => {
    const zip = await JSZip.loadAsync(buf)
    const iflw = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('.iflw'))).async('string')
    return iflw.match(/<bpmn2:messageFlow[\s\S]*?<\/bpmn2:messageFlow>/g).map((m) => m.replace(/ (id|sourceRef|targetRef)="[^"]*"/g, '')).sort()
  }
  const refs = async (buf) => {
    const zip = await JSZip.loadAsync(buf)
    const propdef = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('parameters.propdef'))).async('string')
    return [...propdef.matchAll(/<reference [^>]*\/>/g)].map((m) => m[0]).sort()
  }

  test('the spec is valid without warnings', () => {
    expect(require('../srv/iflow-builder/validator').validate(spec)).toMatchObject({ valid: true, errors: [], warnings: [] })
  })

  test('both receivers (Request Reply and Message End) and the parameter reference are as in the export', async () => {
    const built = await zipOf(spec)
    expect(await flows(built)).toEqual(await flows(readRef('Ref_Receiver_ProcessDirect.zip')))
    expect(await refs(built)).toEqual(await refs(readRef('Ref_Receiver_ProcessDirect.zip')))
  })

  test('update and Import keep the step, the end and the parameter', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const update = specFromParsed(await parse(readRef('Ref_Receiver_ProcessDirect.zip')), { packageId: 'iglowpackage' })
    expect(update.blockers).toEqual([])
    expect(update.spec).toEqual(spec)
    const imported = await importIflow(readRef('Ref_Receiver_ProcessDirect.zip'), { fileName: 'Ref_Receiver_ProcessDirect.zip', packageId: 'iglowpackage' })
    expect(imported).toMatchObject({ valid: true, errors: [], placeholders: 0 })
    expect({ steps: imported.spec.steps, end: imported.spec.end, parameters: imported.spec.parameters }).toEqual({ steps: spec.steps, end: spec.end, parameters: spec.parameters })
  })

  test('a setting the builder does not write: the update is blocked, Import puts a placeholder where the call was', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const zip = await JSZip.loadAsync(readRef('Ref_Receiver_ProcessDirect.zip'))
    const file = Object.keys(zip.files).find((f) => f.endsWith('.iflw'))
    const before = await zip.file(file).async('string')
    const after = before.replace('<value>/dummy/pd/orders</value>', '<value>orders</value>')
    expect(after).not.toBe(before)
    zip.file(file, after)
    const changed = await zip.generateAsync({ type: 'nodebuffer' })
    expect(specFromParsed(await parse(changed), { packageId: 'iglowpackage' }).blockers.join()).toMatch(/receiver RCV_PD_Orders: the address 'orders' is not a path/)
    const imported = await importIflow(changed, { fileName: 'x.zip', packageId: 'iglowpackage' })
    expect(imported.placeholders).toBe(1)
    expect(imported.spec.steps[1]).toMatchObject({ name: 'RR_CallOrders', description: expect.stringMatching(/^REPLACE WITH ProcessDirect request-reply/) })
  })
})

describe('placeholders survive the iFlow: Import and update recognise a REPLACE_WITH step (phase 6)', () => {
  const spec = {
    id: 'Placeholder_Again',
    name: 'Placeholder_Again',
    packageId: 'iglowpackage',
    trigger: { type: 'timer', mode: 'once' },
    steps: [{ type: 'contentModifier', name: 'PH_CallOrders', description: 'REPLACE WITH Request Reply to the order iFlow', properties: [{ name: 'REPLACE_WITH', type: 'constant', value: 'x' }] }],
    end: { type: 'none' }
  }
  test('the description is not in the iFlow, but the REPLACE_WITH property brings the placeholder back', async () => {
    const { specFromParsed } = require('../srv/iflow-builder/to-spec')
    const { importIflow } = require('../srv/iflow-builder/import')
    const { placeholderNames } = require('../srv/iflow-builder/placeholders')
    const zip = Buffer.from((await build(spec)).zipBase64, 'base64')
    const imported = await importIflow(zip, { fileName: 'x.zip', packageId: 'iglowpackage' })
    expect(imported.placeholders).toBe(1)
    expect(imported.spec.steps[0]).toMatchObject({ name: 'PH_CallOrders', description: 'REPLACE WITH Request Reply to the order iFlow' })
    const update = specFromParsed(await parse(zip), { packageId: 'iglowpackage' })
    expect(update.spec.steps[0].description).toBe('REPLACE WITH Request Reply to the order iFlow')
    expect(placeholderNames(update.spec)).toEqual(['PH_CallOrders'])
  })
})
