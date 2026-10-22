/**
 * Import of any iFlow into a draft spec (srv/iflow-builder/import.js). Unsupported content is
 * produced by building an iFlow and patching its .iflw the way CPI would write it.
 */
const JSZip = require('jszip')
const { build } = require('../srv/iflow-builder/builder')
const { importIflow } = require('../srv/iflow-builder/import')
const { validate } = require('../srv/iflow-builder/validator')
const { baseSpec } = require('./helpers')

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

const converters = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ type: 'jsonToXml', name: `S${from + i}` }))

describe('import', () => {
  test('unsupported steps become placeholders, merged to stay within 50 steps; XPath moves into Groovy', async () => {
    const spec = baseSpec({
      steps: [
        { type: 'contentModifier', name: 'Values', properties: [{ name: 'OrderId', type: 'constant', value: '/Order/Id' }, { name: 'Source', type: 'constant', value: 'Shop' }] },
        ...converters(49)
      ],
      end: { type: 'httpReceiver', system: 'Backend', url: 'https://example.org/orders', method: 'POST', authType: 'None' }
    })
    const zip = await zipWith(spec, (x) =>
      rename(rename(rowType(retype(x, ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'], 'Splitter'), '/Order/Id', 'xpath'), 'S10', 'Dup'), 'S11', 'Dup').replace(
        /(<key>authenticationMethod<\/key>\s*)<value>None<\/value>/,
        '$1<value>OAuth2SAMLBearerAssertion</value>'
      )
    )
    const r = await importIflow(zip, { fileName: 'orders.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 1 })
    const names = r.spec.steps.map((s) => s.name)

    // 1 Groovy + 1 Content Modifier + 49 converters = 51 > 50: the 6 splitters became one placeholder
    expect(r.spec.steps).toHaveLength(46)
    const merged = r.spec.steps.find((s) => /^REPLACE WITH /.test(s.description || ''))
    expect(merged).toMatchObject({ type: 'contentModifier', name: 'S3', properties: [{ name: 'REPLACE_WITH', type: 'constant' }] })
    expect(merged.description).toBe("REPLACE WITH Splitter 'S3'; then Splitter 'S4'; then Splitter 'S5'; then Splitter 'S6'; then Splitter 'S7'; then Splitter 'S8'")
    expect(r.notes).toContain('Main flow: 6 consecutive placeholders were merged into one to stay within 50 steps')

    // XPath: a generated script before the Content Modifier, which keeps its constant
    expect(r.spec.steps.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'groovyScript', name: 'Values XPath', fileName: 'xpath_Values' }),
      expect.objectContaining({ type: 'contentModifier', name: 'Values', properties: [{ name: 'Source', type: 'constant', value: 'Shop' }] })
    ])
    expect(r.attachments['xpath_Values.groovy']).toContain("message.setProperty('OrderId', xpath.evaluate('/Order/Id', doc))")

    // unique names, authentication reset to None with a note
    expect(names.filter((n) => n.startsWith('Dup'))).toEqual(['Dup', 'Dup 2'])
    expect(new Set(names).size).toBe(names.length)
    expect(r.spec.end).toMatchObject({ type: 'httpReceiver', system: 'Backend', authType: 'None' })
    expect(r.notes.join('\n')).toMatch(/End receiver Backend: set authentication OAuth2SAMLBearerAssertion/)

    // the generated script is a valid Groovy step for the builder
    const { zipBase64 } = await build(r.spec, { attachments: r.attachments })
    expect(zipBase64).toBeTruthy()
  })

  test('too many real steps are refused with a hint', async () => {
    const spec = baseSpec({
      steps: [{ type: 'contentModifier', name: 'Values', properties: [{ name: 'A', type: 'constant', value: '/a' }, { name: 'B', type: 'constant', value: 'b' }] }, ...converters(49)]
    })
    const zip = await zipWith(spec, (x) => rowType(x, '/a', 'xpath'))
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
    expect(r.notes).toContain('Target package: set one before proposing (session defaults or the proposal panel)')
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

    test('only the main path is imported; side branches are described in the router placeholder', async () => {
      const r = await branchy()
      expect(r.spec.steps.map((s) => s.name)).toEqual(['CM_SetProperties', 'Router 3', 'Main_A', 'Router 5', 'Main_B'])
      const [, router3, , router5] = r.spec.steps
      expect(router3.description).toBe("REPLACE WITH Router 'Router 3': Route 1 (${property.Empty} = 'false') continues; Route 2 (default) -> CM_SetProperty 2 -> PayloadLogging -> End 10")
      expect(router5.description).toBe("REPLACE WITH Router 'Router 5': Route 1 (${property.Count} > {{Limit}}) continues; Route 2 (default) -> Retry_CM -> back to Main_B")
      // the side-branch step does not run on the main path any more
      expect(r.spec.steps.some((s) => s.name === 'CM_SetProperty 2')).toBe(false)
      expect(r.notes).toContain('The flow branches: only the main path was imported (at each router, the route with a condition). 3 step(s) of other routes are described in the 2 router placeholder(s)')
      expect(r.placeholders).toBe(3) // 2 routers + the missing script in error handling
      expect(r).toMatchObject({ valid: true, errors: [] })
    })

    test('{{Param}} outside receiver URLs becomes its default; placeholder text is not a parameter value', async () => {
      const r = await branchy()
      const [setProps, , mainA, router5] = r.spec.steps
      expect(setProps.properties).toEqual([
        { name: 'Source', type: 'constant', value: 'SF' },
        { name: 'KeyValue', type: 'expression', value: '${property.IncidentNumber}' }, // type "property" whose name is a parameter
        { name: 'Auth', type: 'expression', value: '${header.Authorization}' } // type "header"
      ])
      expect(setProps.description).toContain('Parameter defaults used: SourceSystem = SF (was {{SourceSystem}})')
      expect(mainA.headers).toEqual([{ name: 'Client', type: 'expression', value: 'client=100' }])
      expect(mainA.description).toBe('Parameter defaults used: SAP Client = 100 (was {{SAP Client}})')
      // the router's REPLACE_WITH value keeps the condition without {{ }}; the description keeps it as it was
      expect(router5.properties[0].value).toContain('${property.Count} > {Limit}')
      expect(router5.description).toContain('{{Limit}}')
    })

    test('a Content Modifier with an unsupported row stays a real step with that row noted', async () => {
      const r = await branchy()
      const setProps = r.spec.steps[0]
      expect(setProps).toMatchObject({ type: 'contentModifier', name: 'CM_SetProperties' })
      // CPI writes persisted variable rows with Type "persisted variables"
      expect(setProps.description).toMatch(/^Add in the CPI web editor: property QueryDate = persisted variable lastModifiedDateTime \(type persisted variables\) \(not supported by the spec\)/)
      // rows of type "property" and "header" stay real as ${property.X} / ${header.X}
      expect(setProps.properties.map((x) => x.value)).toEqual(['SF', '${property.IncidentNumber}', '${header.Authorization}'])
      expect(setProps.description).not.toMatch(/^REPLACE WITH/)
    })

    test('imports always get a new iFlow id', async () => {
      const r = await branchy()
      expect(r.spec.id).toBe('Branchy_Imported')
      expect(r.notes).toContain('iFlow id: Branchy_Imported, a new id (iFlow ids are unique per tenant); change it before proposing if you like')
    })
    test('error handling: a Process Call to a local process of Content Modifiers and Groovy is copied in', async () => {
      const r = await branchy()
      expect(r.spec.exceptionSubprocess.steps.map((s) => s.name)).toEqual(['CM_SetMessage', 'Script_Groovy_SetCustomHeaders'])
      expect(r.spec.exceptionSubprocess.steps[0]).toMatchObject({ type: 'contentModifier', properties: [{ name: 'Error_Message', type: 'expression', value: '${exception.message}' }] })
      // the script is missing in the export: a placeholder stands in for it
      expect(r.spec.exceptionSubprocess.steps[1].description).toMatch(/^REPLACE WITH Groovy script 'Script_Groovy_SetCustomHeaders' \(Groovy_MPLLogs.groovy is missing in the export\)/)
      expect(r.notes).toContain('PC_Exception Subprocess: the steps of the local process LIP_Exception Subprocess were copied into the exception subprocess (CM_SetMessage, Script_Groovy_SetCustomHeaders)')
      expect(r.notes.join('\n')).not.toMatch(/Local integration processes are not imported/)
    })

    test('an Escalation End in error handling is noted (v1 ends with a Message End)', async () => {
      const r = await branchy()
      expect(r.spec.exceptionSubprocess.steps.at(-1).description).toMatch(/Add in the CPI web editor: Escalation End after this step/)
      expect(r.notes).toContain(
        'Exception subprocess: the original ends with an Escalation End; v1 uses a Message End, so failed messages show as Completed in monitoring. Add in the CPI web editor: Escalation End'
      )
    })
  })
})
