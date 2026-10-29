/**
 * Import of any iFlow into a draft spec (srv/iflow-builder/import.js). Unsupported content is
 * produced by building an iFlow and patching its .iflw the way CPI would write it.
 */
const JSZip = require('jszip')
const { build } = require('../srv/iflow-builder/builder')
const { importIflow } = require('../srv/iflow-builder/import')
const { validate } = require('../srv/iflow-builder/validator')
const { baseSpec, readRef } = require('./helpers')

const IFLW = /src\/main\/resources\/scenarioflows\/integrationflow\/[^/]+\.iflw$/

/** Builds the spec and applies `patch` to the .iflw text; returns the zip as a Buffer */
async function zipWith(spec, patch = (x) => x, { attachments } = {}) {
  const { zipBase64 } = await build(spec, { attachments })
  const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
  const path = Object.keys(zip.files).find((f) => IFLW.test(f))
  zip.file(path, patch(await zip.file(path).async('string')))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** Sets the activityType of the steps whose names match `names` */
const retype = (iflw, names, activityType) =>
  iflw.replace(/(<bpmn2:callActivity id="[^"]+" name="([^"]+)">[\s\S]*?<key>activityType<\/key>\s*<value>)[A-Za-z]+(<\/value>)/g, (m, head, name, tail) =>
    names.includes(name) ? `${head}${activityType}${tail}` : m
  )
const rename = (iflw, from, to) => iflw.replace(`name="${from}"`, `name="${to}"`)
/** Encoded Content Modifier row: Type cell of the row whose Value is `value` */
const rowType = (iflw, value, type) => iflw.replace(`&lt;cell id='Type'&gt;constant&lt;/cell&gt;&lt;cell id='Value'&gt;${value}&lt;`, `&lt;cell id='Type'&gt;${type}&lt;/cell&gt;&lt;cell id='Value'&gt;${value}&lt;`)

/**
 * Inserts a copy of the step `name` right after it, as `copyName` (the builder builds at most 50 steps, an
 * import may get more): the copy takes the step's outgoing flow, a new flow leads from it to the old target
 */
function addStepAfter(iflw, name, copyName) {
  const [block, id] = iflw.match(new RegExp(`<bpmn2:callActivity id="([^"]+)" name="${name}">[\\s\\S]*?</bpmn2:callActivity>`))
  const out = block.match(/<bpmn2:outgoing>([^<]+)<\/bpmn2:outgoing>/)[1]
  const [flow, target] = iflw.match(new RegExp(`<bpmn2:sequenceFlow id="${out}"[^>]*targetRef="([^"]+)"[^>]*/?>`))
  const copyId = `${id}_copy`
  const copyFlow = `${out}_copy`
  const copy = block
    .replace(`id="${id}"`, `id="${copyId}"`)
    .replace(`name="${name}"`, `name="${copyName}"`)
    .replace(/<bpmn2:incoming>[^<]+<\/bpmn2:incoming>/, `<bpmn2:incoming>${out}</bpmn2:incoming>`)
    .replace(/<bpmn2:outgoing>[^<]+<\/bpmn2:outgoing>/, `<bpmn2:outgoing>${copyFlow}</bpmn2:outgoing>`)
  return iflw
    .replace(block, block + copy)
    .replace(flow, flow.replace(`targetRef="${target}"`, `targetRef="${copyId}"`) + `<bpmn2:sequenceFlow id="${copyFlow}" sourceRef="${copyId}" targetRef="${target}"/>`)
    .replace(new RegExp(`(<bpmn2:[A-Za-z]+ id="${target}"[\\s\\S]*?<bpmn2:incoming>)${out}(</bpmn2:incoming>)`), `$1${copyFlow}$2`)
}

const converters = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ type: 'jsonToXml', name: `S${from + i}` }))

describe('import keeps HTTP receiver settings (Ref_Receivers)', () => {
  test('authentication, credential name, proxy and location ID are kept, parameters as parameters (step c2)', async () => {
    const r = await importIflow(readRef('Ref_Receivers.zip'), { fileName: 'Ref_Receivers.zip', packageId: 'PilotReference' })
    const http = r.spec.steps.filter((s) => s.type === 'requestReplyHttp').map(({ name, authType, credentialName, proxyType, locationId }) => ({ name, authType, credentialName, proxyType, locationId }))
    expect(http).toEqual([
      { name: 'RR_Basic', authType: 'Basic', credentialName: '{{BasicCredential}}', proxyType: undefined, locationId: undefined },
      { name: 'RR_OAuth', authType: 'OAuth2 Client Credentials', credentialName: '{{RR_OAuth_CredentialName}}', proxyType: undefined, locationId: undefined },
      { name: 'RR_OnPrem', authType: 'Basic', credentialName: 'DUMMY_ONPREM_CRED', proxyType: 'On-Premise', locationId: '{{RR_OnPrem_LocationId}}' }
    ])
    expect(r.spec.parameters).toMatchObject({ BasicCredential: 'DUMMY_BASIC_CRED', RR_OAuth_CredentialName: 'DUMMY_OAUTH_CRED', RR_OnPrem_LocationId: 'DUMMY_LOC' })
    expect(r.notes.filter((n) => /credential|location/i.test(n))).toEqual([])
    expect(r.valid).toBe(true)
  })
})

describe('import keeps phase 1a content (Ref_Variables, Ref_Router_Ends)', () => {
  test('Content Modifier sources, a constant parameter with its default, Write Variables; the empty iGlow subprocess is left out', async () => {
    const r = await importIflow(readRef('Ref_Variables.zip'), { fileName: 'Ref_Variables.zip', packageId: 'PilotReference' })
    expect(r.valid).toBe(true)
    const [, read, write] = r.spec.steps
    expect(read.properties.map((p) => `${p.name}:${p.type}`)).toEqual([
      'p_global:globalVariable',
      'p_local:localVariable',
      'p_header:header',
      'p_property:property',
      'p_xpath:xpath',
      'p_constant:constant',
      'p_expr:expression',
      'p_param:constant'
    ])
    expect(read.properties.at(-1)).toEqual({ name: 'p_param', type: 'constant', value: '{{DummyParam}}', default: 'default-value' })
    expect(r.spec.parameters).toEqual({ DummyParam: 'dummy-value' })
    expect(write).toMatchObject({ type: 'writeVariables', variables: [{ name: 'DUMMY_GLOBAL_VAR', global: true }, { name: 'DUMMY_LOCAL_VAR', type: 'xpath' }] })
    expect(r.spec.exceptionSubprocess).toBeUndefined()
  })

  test('a timer every 15 minutes stays a timer every 15 minutes', async () => {
    const r = await importIflow(readRef('Ref_Router_Ends.zip'), { fileName: 'Ref_Router_Ends.zip', packageId: 'PilotReference' })
    expect(r.spec.trigger).toEqual({ type: 'timer', mode: 'every', minutes: 15 })
    expect(r.notes.join('\n')).not.toMatch(/became "run once/)
  })
})

describe('import', () => {
  test('unsupported steps become placeholders, merged to stay within 50 steps; XPath stays an XPath row', async () => {
    const spec = baseSpec({
      steps: [
        { type: 'contentModifier', name: 'Values', properties: [{ name: 'OrderId', type: 'constant', value: '/Order/Id' }, { name: 'Source', type: 'constant', value: 'Shop' }] },
        ...converters(49)
      ],
      end: { type: 'httpReceiver', system: 'Backend', url: 'https://example.org/orders', method: 'POST', authType: 'None' }
    })
    const zip = await zipWith(spec, (x) =>
      rename(rename(rowType(retype(addStepAfter(x, 'S49', 'S50'), ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'], 'Splitter'), '/Order/Id', 'xpath'), 'S10', 'Dup'), 'S11', 'Dup').replace(
        /(<key>authenticationMethod<\/key>\s*)<value>None<\/value>/,
        '$1<value>OAuth2SAMLBearerAssertion</value>'
      )
    )
    const r = await importIflow(zip, { fileName: 'orders.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 1 })
    const names = r.spec.steps.map((s) => s.name)

    // 1 Content Modifier + 50 converters = 51 > 50: the 6 splitters became one placeholder
    expect(r.spec.steps).toHaveLength(46)
    const merged = r.spec.steps.find((s) => /^REPLACE WITH /.test(s.description || ''))
    expect(merged).toMatchObject({ type: 'contentModifier', name: 'S3', properties: [{ name: 'REPLACE_WITH', type: 'constant' }] })
    expect(merged.description).toBe("REPLACE WITH Splitter 'S3'; then Splitter 'S4'; then Splitter 'S5'; then Splitter 'S6'; then Splitter 'S7'; then Splitter 'S8'")
    expect(r.notes).toContain('Main flow: 6 consecutive placeholders were merged into one to stay within 50 steps')

    // XPath: kept as an XPath row (phase 1a), no generated script
    expect(r.spec.steps[0]).toEqual({
      type: 'contentModifier',
      name: 'Values',
      properties: [
        { name: 'OrderId', type: 'xpath', value: '/Order/Id' },
        { name: 'Source', type: 'constant', value: 'Shop' }
      ]
    })
    expect(r.attachments).toEqual({})

    // unique names; an authentication method the spec cannot hold is reset to None with a note
    expect(names.filter((n) => n.startsWith('Dup'))).toEqual(['Dup', 'Dup 2'])
    expect(new Set(names).size).toBe(names.length)
    expect(r.spec.end).toMatchObject({ type: 'httpReceiver', system: 'Backend', authType: 'None' })
    expect(r.notes.join('\n')).toMatch(/End receiver Backend: set authentication 'OAuth2SAMLBearerAssertion' in the CPI web editor/)

    // the generated script is a valid Groovy step for the builder
    const { zipBase64 } = await build(r.spec, { attachments: r.attachments })
    expect(zipBase64).toBeTruthy()
  })

  test('too many real steps are refused with a hint', async () => {
    const spec = baseSpec({
      steps: [{ type: 'contentModifier', name: 'Values', properties: [{ name: 'A', type: 'constant', value: '/a' }, { name: 'B', type: 'constant', value: 'b' }] }, ...converters(49)]
    })
    const zip = await zipWith(spec, (x) => addStepAfter(x, 'S49', 'S50')) // 51 real steps
    await expect(importIflow(zip, { fileName: 'big.zip' })).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', status: 400 })
  })

  test('a bare .iflw: id from the file name, missing scripts become placeholders', async () => {
    const { GROOVY } = require('./helpers')
    const spec = baseSpec({ steps: [{ type: 'groovyScript', name: 'Script', fileName: 'doIt', code: GROOVY }] })
    const { files } = await build(spec)
    const iflw = files.find((f) => IFLW.test(f.path)).content
    const r = await importIflow(Buffer.from(iflw), { fileName: 'My Flow.iflw' })
    expect(r.spec).toMatchObject({ id: 'My_Flow_Imported', packageId: 'Imported', trigger: { type: 'httpsSender', address: '/test/flow' } })
    expect(r.spec.steps[0].description).toMatch(/^REPLACE WITH Groovy script 'Script' \(doIt.groovy is missing in the export\)/)
    expect(r.notes).toContain('Target package: set one before proposing (in your message or in the proposal panel)')
    expect(validate(r.spec, { attachments: Object.keys(r.attachments) }).valid).toBe(true)
  })

  test('a receiver URL combined from parameters stays externalized as one <System>_URL parameter', async () => {
    const spec = baseSpec({ end: { type: 'httpReceiver', system: 'RCV_SOURCE_SYSTEM', url: '{{ReceiverURL}}', method: 'GET', authType: 'None' }, parameters: { ReceiverURL: 'https://x.org' } })
    const { zipBase64 } = await build(spec)
    const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
    const path = Object.keys(zip.files).find((f) => IFLW.test(f))
    const iflw = (await zip.file(path).async('string')).replace('<value>{{ReceiverURL}}</value>', '<value>{{HTTP_Address}}</value>')
    expect(iflw).toMatch(/<key>httpAddressQuery<\/key>\s*<value\/>/)
    zip.file(path, iflw.replace(/(<key>httpAddressQuery<\/key>\s*)<value\/>/, '$1<value>{{HTTP_Query}}</value>'))
    zip.file('src/main/resources/parameters.prop', 'HTTP_Address=https\\://source.example.com/api/records\nHTTP_Query=sysparm_fields=number&sysparm_query=x%3E${property.LastQueryDate}\n')
    const r = await importIflow(await zip.generateAsync({ type: 'nodebuffer' }), { fileName: 'snow.zip', packageId: 'PilotReference' })

    expect(r.spec.end).toMatchObject({ type: 'httpReceiver', system: 'RCV_SOURCE_SYSTEM', url: '{{RCV_SOURCE_SYSTEM_URL}}' })
    expect(r.spec.parameters.RCV_SOURCE_SYSTEM_URL).toBe('https://source.example.com/api/records?sysparm_fields=number&sysparm_query=x%3E${property.LastQueryDate}')
    expect(r.notes).toContain('RCV_SOURCE_SYSTEM: the URL {{HTTP_Address}}?{{HTTP_Query}} became the parameter {{RCV_SOURCE_SYSTEM_URL}} with the combined value as its default')
    expect(r).toMatchObject({ valid: true, errors: [] })
  })

  describe('branching flows (manual test 15)', () => {
    const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const prop = (key, value) => `<ifl:property><key>${key}</key><value>${esc(value)}</value></ifl:property>`
    const row = (name, type, value) => `<row><cell id='Action'>Create</cell><cell id='Type'>${type}</cell><cell id='Value'>${value}</cell><cell id='Name'>${name}</cell></row>`
    const cm = (id, name, { properties = [], headers = [] } = {}) =>
      `<bpmn2:callActivity id="${id}" name="${name}"><bpmn2:extensionElements>${prop('activityType', 'Enricher')}${prop('propertyTable', properties.join(''))}${prop('headerTable', headers.join(''))}</bpmn2:extensionElements></bpmn2:callActivity>`
    const flow = (id, from, to, { name, condition } = {}) =>
      `<bpmn2:sequenceFlow id="${id}" sourceRef="${from}" targetRef="${to}"${name ? ` name="${name}"` : ''}>${condition ? `<bpmn2:conditionExpression id="${id}_c">${esc(condition)}</bpmn2:conditionExpression>` : ''}</bpmn2:sequenceFlow>`

    /**
     * Start -> CM_SetProperties -> Router 3
     *   Route 1 (condition): Main_A -> Router 5
     *     Route 1 (condition): Main_B -> End
     *     Route 2 (default): Retry -> back to Main_B
     *   Route 2 (default): CM_SetProperty 2 -> PayloadLogging -> End 10
     */
    const IFLW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd" id="Definitions_1">
  <bpmn2:collaboration id="Collaboration_1"><bpmn2:participant id="Participant_Process_1" ifl:type="IntegrationProcess" name="Integration Process" processRef="Process_1"/></bpmn2:collaboration>
  <bpmn2:process id="Process_1" name="Integration Process">
    <bpmn2:startEvent id="Start" name="Start"><bpmn2:timerEventDefinition id="Timer"><bpmn2:extensionElements>${prop('scheduleKey', 'simple.repeat=NONE')}</bpmn2:extensionElements></bpmn2:timerEventDefinition></bpmn2:startEvent>
    ${cm('CM1', 'CM_SetProperties', { properties: [row('Source', 'constant', '{{SourceSystem}}'), row('QueryDate', 'persisted variables', 'lastModifiedDateTime'), row('KeyValue', 'property', '{{KeyProperty}}'), row('Auth', 'header', 'Authorization')] })}
    <bpmn2:exclusiveGateway id="R3" name="Router 3" default="F_R3_2"/>
    ${cm('A', 'Main_A', { headers: [row('Client', 'expression', 'client={{SAP Client}}')] })}
    <bpmn2:exclusiveGateway id="R5" name="Router 5" default="F_R5_2"/>
    ${cm('B', 'Main_B')}
    ${cm('Retry', 'Retry_CM')}
    ${cm('S1', 'CM_SetProperty 2', { properties: [row('AttachmentName', 'constant', 'Target_Failed_Response')] })}
    <bpmn2:callActivity id="S2" name="PayloadLogging"><bpmn2:extensionElements>${prop('activityType', 'Script')}${prop('subActivityType', 'GroovyScript')}${prop('script', 'log.groovy')}</bpmn2:extensionElements></bpmn2:callActivity>
    <bpmn2:endEvent id="End" name="End"/>
    <bpmn2:endEvent id="End10" name="End 10"/>
    <bpmn2:subProcess id="ESP" name="Exception Subprocess"><bpmn2:extensionElements>${prop('activityType', 'ErrorEventSubProcessTemplate')}</bpmn2:extensionElements>
      <bpmn2:startEvent id="ESP_Start" name="Error Start"><bpmn2:errorEventDefinition/></bpmn2:startEvent>
      <bpmn2:callActivity id="PC" name="PC_Exception Subprocess"><bpmn2:extensionElements>${prop('activityType', 'ProcessCallElement')}${prop('processId', 'Process_2')}</bpmn2:extensionElements></bpmn2:callActivity>
      <bpmn2:endEvent id="ESP_End" name="Escalation End 1"><bpmn2:escalationEventDefinition/></bpmn2:endEvent>
      ${flow('E1', 'ESP_Start', 'PC')}
      ${flow('E2', 'PC', 'ESP_End')}
    </bpmn2:subProcess>
    ${flow('F1', 'Start', 'CM1')}
    ${flow('F2', 'CM1', 'R3')}
    ${flow('F_R3_1', 'R3', 'A', { name: 'Route 1', condition: "${property.Empty} = 'false'" })}
    ${flow('F_R3_2', 'R3', 'S1', { name: 'Route 2' })}
    ${flow('F3', 'A', 'R5')}
    ${flow('F_R5_1', 'R5', 'B', { name: 'Route 1', condition: '${property.Count} > {{Limit}}' })}
    ${flow('F_R5_2', 'R5', 'Retry', { name: 'Route 2' })}
    ${flow('F4', 'Retry', 'B')}
    ${flow('F5', 'B', 'End')}
    ${flow('F6', 'S1', 'S2')}
    ${flow('F7', 'S2', 'End10')}
  </bpmn2:process>
  <bpmn2:process id="Process_2" name="LIP_Exception Subprocess">
    <bpmn2:extensionElements>${prop('processType', 'directCall')}</bpmn2:extensionElements>
    <bpmn2:startEvent id="L_Start" name="Start 2"/>
    ${cm('L1', 'CM_SetMessage', { properties: [row('Error_Message', 'expression', '${exception.message}')] })}
    <bpmn2:callActivity id="L2" name="Script_Groovy_SetCustomHeaders"><bpmn2:extensionElements>${prop('activityType', 'Script')}${prop('subActivityType', 'GroovyScript')}${prop('script', 'Groovy_MPLLogs.groovy')}</bpmn2:extensionElements></bpmn2:callActivity>
    <bpmn2:endEvent id="L_End" name="End 2"/>
    ${flow('L_F1', 'L_Start', 'L1')}
    ${flow('L_F2', 'L1', 'L2')}
    ${flow('L_F3', 'L2', 'L_End')}
  </bpmn2:process>
</bpmn2:definitions>`

    async function branchy() {
      const zip = new JSZip()
      zip.file('src/main/resources/scenarioflows/integrationflow/Branchy.iflw', IFLW)
      zip.file('src/main/resources/parameters.prop', 'SourceSystem=SF\nLimit=5\nSAP\\ Client=100\nKeyProperty=IncidentNumber\n')
      zip.file('src/main/resources/script/log.groovy', require('./helpers').GROOVY)
      return importIflow(await zip.generateAsync({ type: 'nodebuffer' }), { fileName: 'Branchy.zip', packageId: 'PilotReference' })
    }

    test('routers are imported with their routes: a route that ends, and one that joins the next step (phase 1b)', async () => {
      const r = await branchy()
      expect(r.spec.steps.map((s) => s.name)).toEqual(['CM_SetProperties', 'Router 3', 'Main_A', 'Router 5', 'Main_B'])
      const [, router3, , router5] = r.spec.steps
      expect(router3).toMatchObject({
        type: 'router',
        expressionType: 'NonXML',
        routes: [
          { name: 'Route 1', condition: "${property.Empty} = 'false'" },
          { name: 'Route 2', default: true, steps: [{ name: 'CM_SetProperty 2' }, { name: 'PayloadLogging' }], end: { event: 'message', name: 'End 10' } }
        ]
      })
      // Retry_CM runs back into Main_B, the step after the router: a join, not a loop
      expect(router5.routes).toMatchObject([
        { name: 'Route 1', condition: '${property.Count} > 5' }, // {{Limit}} became its default
        { name: 'Route 2', default: true, steps: [{ name: 'Retry_CM' }] }
      ])
      expect(router5.routes[1].end).toBeUndefined()
      expect(r.notes).toContain('The flow branches: 2 router(s) were imported with their routes')
      expect(r.placeholders).toBe(1) // the missing script in error handling
      expect(r).toMatchObject({ valid: true, errors: [] })
    })

    test('{{Param}} stays as a whole constant value; elsewhere it becomes its default; placeholder text is not a parameter value', async () => {
      const r = await branchy()
      const [setProps, , mainA] = r.spec.steps
      expect(setProps.properties).toEqual([
        { name: 'Source', type: 'constant', value: '{{SourceSystem}}' }, // an externalized constant (phase 1a)
        { name: 'QueryDate', type: 'localVariable', value: 'lastModifiedDateTime' }, // CPI type "persisted variables"
        { name: 'KeyValue', type: 'property', value: 'IncidentNumber' }, // type "property" whose name is a parameter
        { name: 'Auth', type: 'header', value: 'Authorization' } // type "header"
      ])
      expect(r.spec.parameters).toMatchObject({ SourceSystem: 'SF' })
      expect(setProps.description).toBe('Parameter defaults used: KeyProperty = IncidentNumber (was {{KeyProperty}})')
      expect(mainA.headers).toEqual([{ name: 'Client', type: 'expression', value: 'client=100' }])
      expect(mainA.description).toBe('Parameter defaults used: SAP Client = 100 (was {{SAP Client}})')
      // a router condition takes the parameter's default (Router 5: covered above)
    })

    test('a Content Modifier with a row the spec cannot hold stays a real step with that row noted', async () => {
      const r = await branchy()
      const setProps = r.spec.steps[0]
      expect(setProps).toMatchObject({ type: 'contentModifier', name: 'CM_SetProperties' })
      // every row of this fixture is supported now (phase 1a); an unknown source type is noted
      const zip = await zipWith(baseSpec({ steps: [{ type: 'contentModifier', name: 'CM', properties: [{ name: 'N', type: 'constant', value: 'x' }, { name: 'K', type: 'constant', value: 'k' }] }] }), (x) =>
        rowType(x, 'x', 'number range')
      )
      const cm = (await importIflow(zip, { fileName: 'cm.zip' })).spec.steps[0]
      expect(cm).toMatchObject({ type: 'contentModifier', name: 'CM', properties: [{ name: 'K', type: 'constant', value: 'k' }] })
      expect(cm.description).toBe('Add in the CPI web editor: property N (source type number range) (not supported by the spec)')
    })

    test('imports always get a new iFlow id', async () => {
      const r = await branchy()
      expect(r.spec.id).toBe('Branchy_Imported')
      expect(r.notes).toContain('iFlow id: Branchy_Imported, a new id (iFlow ids are unique per tenant); change it before proposing if you like')
    })
    test('error handling: the Process Call stays, and its local process is imported (phase 2)', async () => {
      const r = await branchy()
      expect(r.spec.exceptionSubprocess.steps).toEqual([{ type: 'processCall', name: 'PC_Exception Subprocess', process: 'LIP_Exception Subprocess' }])
      const lip = r.spec.localProcesses.find((p) => p.name === 'LIP_Exception Subprocess')
      expect(lip.steps.map((s) => s.name)).toEqual(['CM_SetMessage', 'Script_Groovy_SetCustomHeaders'])
      expect(lip.steps[0]).toMatchObject({ type: 'contentModifier', properties: [{ name: 'Error_Message', type: 'expression', value: '${exception.message}' }] })
      // the script is missing in the export: a placeholder stands in for it
      expect(lip.steps[1].description).toMatch(/^REPLACE WITH Groovy script 'Script_Groovy_SetCustomHeaders' \(Groovy_MPLLogs.groovy is missing in the export\)/)
      expect(r.notes.join('\n')).not.toMatch(/copied into|not imported/)
    })

    test('an Escalation End in error handling is kept as the subprocess end (phase 1b)', async () => {
      const r = await branchy()
      expect(r.spec.exceptionSubprocess.end).toMatchObject({ event: 'escalation' })
      expect(r.spec.exceptionSubprocess.steps.at(-1).description ?? '').not.toMatch(/Escalation End/)
    })
  })
})

describe('import: splitters, gathers, process calls and local processes (phase 2)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const split = (name, extra = {}) => ({ type: 'splitter', name, kind: 'iterating', expression: '//item', stopOnException: true, ...extra })
  const setting = (xml, name, key, value) => {
    const el = xml.match(new RegExp(`<bpmn2:callActivity id="[^"]+" name="${name}">[\\s\\S]*?</bpmn2:callActivity>`))[0]
    return xml.replace(el, el.replace(new RegExp(`(<key>${key}</key>\\s*)(<value>[^<]*</value>|<value/>)`), `$1<value>${value}</value>`))
  }
  const spec = baseSpec({
    steps: [split('S1'), { type: 'processCall', name: 'PC', process: 'L' }, { type: 'gather', name: 'G', source: '//item', target: '/items' }, split('S2')],
    localProcesses: [{ name: 'L', steps: [cm('L1')] }]
  })

  test('a flow the spec holds imports as it is', async () => {
    const r = await importIflow(await zipWith(spec), { fileName: 'split.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, placeholders: 0 })
    expect(r.spec.steps).toEqual(spec.steps)
    expect(r.spec.localProcesses).toEqual(spec.localProcesses)
  })

  test('a splitter the spec cannot hold is a placeholder; its gather then too (no splitter before it)', async () => {
    const r = await importIflow(await zipWith(spec, (x) => setting(x, 'S1', 'ParallelProcessing', 'true')), { fileName: 'split.zip', packageId: 'PilotReference' })
    expect(r.valid).toBe(true)
    expect(r.spec.steps.map((s) => [s.name, s.type, s.description || ''])).toEqual([
      ['S1', 'contentModifier', "REPLACE WITH Iterating Splitter 'S1' (XPath //item), parallel processing"],
      ['PC', 'processCall', ''],
      ['G', 'contentModifier', "REPLACE WITH Gather 'G' (combine at //item into /items) without a splitter before it"],
      ['S2', 'splitter', '']
    ])
  })

  test('a Looping Process Call keeps its loop; a condition without spaces gets them', async () => {
    const looping = baseSpec({ steps: [{ type: 'processCall', name: 'LPC', process: 'L', loop: { condition: "${property.more} = 'true'", max: 4 } }], localProcesses: [{ name: 'L', steps: [cm('L1')] }] })
    const r = await importIflow(await zipWith(looping, (x) => x.replace("${property.more} = 'true'", "${property.more}='true'")), { fileName: 'loop.zip', packageId: 'PilotReference' })
    expect(r.spec.steps).toEqual([{ type: 'processCall', name: 'LPC', process: 'L', loop: { condition: "${property.more} = 'true'", max: 4 } }])
    expect(r.valid).toBe(true)
  })

  test('steps a local process cannot hold become placeholders there', async () => {
    const r = await importIflow(await zipWith(spec, (x) => setting(x, 'L1', 'activityType', 'Splitter')), { fileName: 'split.zip', packageId: 'PilotReference' })
    expect(r.spec.localProcesses[0].steps[0].description).toMatch(/^REPLACE WITH Splitter 'L1': splitters are supported on the main line only/)
    expect(r.valid).toBe(true)
  })
})
