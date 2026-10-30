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

describe('end events on update: Message, Escalation and Error End are kept (phase 1b); a Terminate End is a blocker', () => {
  // end events of the built iFlow: the main end first, the exception subprocess end second
  const endDef = (which, def) => (xml) => {
    let i = 0
    return xml.replace(/<bpmn2:messageEventDefinition\/>(\s*<\/bpmn2:endEvent>)/g, (m, close) => (i++ === which ? `<bpmn2:${def}/>${close}` : m))
  }

  test('an Error End in the exception subprocess is kept as its end event', async () => {
    const r = await readBack(endDef(1, 'errorEventDefinition'))
    expect(r.blockers).toEqual([])
    expect(r.spec.exceptionSubprocess.end).toEqual({ event: 'error', name: 'End 1' })
  })

  test('an Escalation End of the main flow is kept as end.event', async () => {
    const r = await readBack(endDef(0, 'escalationEventDefinition'))
    expect(r.blockers).toEqual([])
    expect(r.spec.end).toEqual({ type: 'none', event: 'escalation' })
  })

  test('a Terminate End is a blocker', async () => {
    const r = await readBack(endDef(0, 'terminateEventDefinition'))
    expect(r.blockers).toEqual(['the main flow ends with a terminate end (only Message, Escalation or Error End)'])
  })
})

describe('Escalation End category on update and import (phase 1b)', () => {
  const { importIflow } = require('../srv/iflow-builder/import')
  const escalate = (category) => (xml) => {
    // the exception subprocess's Message End becomes an Escalation End with this category
    let i = 0
    return xml.replace(/<bpmn2:messageEventDefinition\/>(\s*<\/bpmn2:endEvent>)/g, (m, close) =>
      i++ === 1
        ? `<bpmn2:escalationEventDefinition><bpmn2:extensionElements><ifl:property><key>ErrorCode</key><value>${category}</value></ifl:property></bpmn2:extensionElements></bpmn2:escalationEventDefinition>${close}`
        : m
    )
  }
  test('an allowed category is kept; another one is a blocker', async () => {
    expect((await readBack(escalate('RoutingConditionNotMet'))).spec.exceptionSubprocess.end).toEqual({ event: 'escalation', name: 'End 1', category: 'RoutingConditionNotMet' })
    expect((await readBack(escalate('ReceiverNotFound'))).blockers).toEqual([
      "the exception subprocess ends with an Escalation End of category 'ReceiverNotFound', which an update cannot keep"
    ])
  })
  test('import: another category becomes Others, with a note', async () => {
    const zip = await JSZip.loadAsync(Buffer.from((await build(spec)).zipBase64, 'base64'))
    const file = Object.keys(zip.files).find((f) => IFLW.test(f))
    zip.file(file, escalate('ReceiverNotFound')(await zip.file(file).async('string')))
    const r = await importIflow(await zip.generateAsync({ type: 'nodebuffer' }), { fileName: 'x.zip', packageId: 'PilotReference' })
    expect(r.spec.exceptionSubprocess.end).toMatchObject({ event: 'escalation', category: 'Others' })
    expect(r.notes).toContain('Exception subprocess: the escalation category ReceiverNotFound became Others; set ReceiverNotFound in the CPI web editor')
  })
})

describe('splitters, gathers, process calls and local processes on update (phase 2)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const phase2 = baseSpec({
    id: 'Blocker_Split',
    steps: [
      { type: 'splitter', name: 'Split', kind: 'iterating', expression: '//item', stopOnException: false },
      { type: 'processCall', name: 'Handle', process: 'LIP_Handle' },
      { type: 'gather', name: 'Gather', source: '//item', target: '/items' },
      { type: 'processCall', name: 'Loop', process: 'LIP_Handle', loop: { condition: "${property.more} = 'true'", max: 3 } }
    ],
    exceptionSubprocess: { steps: [{ type: 'processCall', name: 'OnError', process: 'LIP_Handle' }], end: { event: 'error' } },
    localProcesses: [{ name: 'LIP_Handle', steps: [cm('H1'), { type: 'requestReplyHttp', name: 'H2', system: 'Backend', url: 'https://backend.example.com/api', method: 'POST', authType: 'None' }] }]
  })
  /** Builds phase2, patches the element with the given name, and reads it back like an update */
  async function readBackPatched(name, patch = (el) => el) {
    const zip = await JSZip.loadAsync(Buffer.from((await build(phase2)).zipBase64, 'base64'))
    const file = Object.keys(zip.files).find((f) => IFLW.test(f))
    const xml = await zip.file(file).async('string')
    const el = xml.match(new RegExp(`<bpmn2:callActivity id="[^"]+" name="${name}">[\\s\\S]*?</bpmn2:callActivity>`))[0]
    zip.file(file, xml.replace(el, patch(el)))
    return specFromParsed(await parse(await zip.generateAsync({ type: 'nodebuffer' })), { packageId: phase2.packageId })
  }

  test("the builder's own output gives the same spec back", async () => {
    const r = await readBackPatched('Split')
    expect(r.blockers).toEqual([])
    expect(r.spec.steps).toEqual(phase2.steps)
    expect(r.spec.exceptionSubprocess.steps).toEqual(phase2.exceptionSubprocess.steps)
    expect(r.spec.localProcesses).toEqual(phase2.localProcesses)
  })

  test('settings the builder writes as fixed values are blockers when they differ', async () => {
    expect((await readBackPatched('Split', (el) => setting(el, 'ParallelProcessing', 'true'))).blockers).toEqual([
      "step 1 'Split': ParallelProcessing is 'true'; an update would reset it to 'false'"
    ])
    expect((await readBackPatched('Split', (el) => setting(el, 'exprType', 'LineBreak'))).blockers).toEqual(["step 1 'Split': exprType is 'LineBreak'; an update would reset it to 'XPath'"])
    expect((await readBackPatched('Split', (el) => setting(el, 'timeOut', '600'))).blockers).toEqual(["step 1 'Split': timeOut is '600'; an update would reset it to '300'"])
    expect((await readBackPatched('Gather', (el) => setting(el, 'aggregationAlgorithm', 'sap-pi-multi-mapping'))).blockers).toEqual([
      "step 3 'Gather': aggregationAlgorithm is 'sap-pi-multi-mapping'; an update would reset it to 'xpath-merge-strategy'"
    ])
    expect((await readBackPatched('Loop', (el) => setting(el, 'expressionType', 'XML'))).blockers).toEqual(["step 4 'Loop': expressionType is 'XML'; an update would reset it to 'Non XML'"])
  })

  test('other splitters and process calls are blockers', async () => {
    expect((await readBackPatched('Split', (el) => setting(el, 'splitType', 'Tokenizer'))).blockers).toEqual([
      "step 1 'Split': a Tokenizer is not supported by the spec (only Iterating and General Splitter)"
    ])
    expect((await readBackPatched('Handle', (el) => setting(el, 'subActivityType', 'IdempotentProcess'))).blockers).toEqual([
      "step 2 'Handle': a IdempotentProcess is not supported by the spec (only Process Call and Looping Process Call)"
    ])
  })
})

describe('SOAP and Mail receivers on update (phase 3)', () => {
  const soapMail = baseSpec({
    id: 'Blocker_Receivers',
    steps: [
      { type: 'requestReplySoap', name: 'RR', system: 'SysS', url: 'http://s4dummy/x', authType: 'Basic', credentialName: 'CRED', proxyType: 'On-Premise', locationId: 'LOC', timeout: 90000 },
      { type: 'sendMail', name: 'SND', system: 'SysM', server: 'smtp.example.com:587', credentialName: 'CRED', from: 'a@example.com', to: 'b@example.com', cc: 'c@example.com', subject: 'Hi', body: 'Text' }
    ]
  })
  async function readBackFlow(component, patch = (x) => x) {
    const zip = await JSZip.loadAsync(Buffer.from((await build(soapMail)).zipBase64, 'base64'))
    const file = Object.keys(zip.files).find((f) => IFLW.test(f))
    const xml = await zip.file(file).async('string')
    const el = xml.match(new RegExp(`<bpmn2:messageFlow id="[^"]+" name="${component}"[\\s\\S]*?</bpmn2:messageFlow>`))[0]
    zip.file(file, xml.replace(el, patch(el)))
    return specFromParsed(await parse(await zip.generateAsync({ type: 'nodebuffer' })), { packageId: soapMail.packageId })
  }

  test("the builder's own output gives the same spec back", async () => {
    const r = await readBackFlow('SOAP')
    expect(r.blockers).toEqual([])
    expect(r.spec.steps).toEqual(soapMail.steps)
  })

  test('what the spec cannot hold is a blocker, not reset: a WSDL, WS-Security, other authentication, mail attachments or protection', async () => {
    const blocker = async (component, key, value) => (await readBackFlow(component, (el) => setting(el, key, value))).blockers
    expect(await blocker('SOAP', 'soapWsdlURL', '/wsdl/x.wsdl')).toEqual(["step 1 'RR': receiver SysS: soapWsdlURL is '/wsdl/x.wsdl'; an update would reset it to '(empty)'"])
    expect(await blocker('SOAP', 'WSSecurity_outbound', 'SignMessage')).toEqual(["step 1 'RR': receiver SysS: WSSecurity_outbound is 'SignMessage'; an update would reset it to 'None'"])
    expect((await blocker('SOAP', 'authentication', 'None'))[0]).toMatch(/authentication is 'None'; an update would reset it to 'Basic'/)
    expect(await blocker('Mail', 'ssl', 'none')).toEqual(["step 2 'SND': receiver SysM: ssl is 'none'; an update would reset it to 'starttls_mandatory'"])
    expect(await blocker('Mail', 'attachments', 'x')).toEqual(["step 2 'SND': receiver SysM: attachments is 'x'; an update would reset it to '(empty)'"])
  })
})
