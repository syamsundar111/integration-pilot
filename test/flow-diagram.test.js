/**
 * app/integration-pilot/webapp/util/flowDiagram.js through a minimal sap.ui.define stub (as in
 * test/generate-controller.test.js): the diagram model of a spec and of a parsed iFlow.
 */
const path = require('path')
const fs = require('fs')
const { parse } = require('../srv/iflow-builder/parser')

const WEBAPP = path.join(__dirname, '../app/integration-pilot/webapp')

/** Loads a sap.ui.define module and returns its factory */
function factoryOf(file) {
  let factory
  global.sap = { ui: { define: (_deps, f) => (factory = f) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return factory
}

const markdown = factoryOf(path.join(WEBAPP, 'util/markdown.js'))()
const IconPool = { getIconInfo: () => null } // no icons in tests
const flowDiagram = factoryOf(path.join(WEBAPP, 'util/flowDiagram.js'))(IconPool, markdown)

describe('flow diagram: splitters, gathers, process calls and local processes (phase 2)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const spec = {
    trigger: { type: 'timer', mode: 'once' },
    steps: [
      cm('A'),
      { type: 'splitter', kind: 'iterating', expression: '//order', stopOnException: false },
      { type: 'processCall', process: 'LIP_Handle' },
      { type: 'gather', source: '//order', target: '/orders' },
      { type: 'processCall', process: 'LIP_Handle', loop: { condition: '${property.x} = 1', max: 5 } }
    ],
    end: { type: 'none' },
    localProcesses: [{ name: 'LIP_Handle', steps: [cm('H1')] }]
  }

  test('from a spec: default names as the builder gives them, details, per-item steps, local processes', () => {
    const model = flowDiagram.fromSpec(spec)
    expect(model.steps.map((s) => [s.name, s.detail, !!s.perItem])).toEqual([
      ['A', '1 value', false],
      ['Iterating Splitter 1', 'Iterating //order', false],
      ['Process Call 1', '→ LIP_Handle', true],
      ['Gather 1', 'into /orders', false],
      ['Looping Process Call 1', '→ LIP_Handle, loop max 5', false]
    ])
    expect(model.locals).toEqual([{ name: 'LIP_Handle', steps: ['H1'] }])
    const html = flowDiagram.toHtml(model)
    expect(html).toContain('Process Call · per item')
    expect(html).toContain('Local process LIP_Handle: Start → H1 → End')
  })

  test('from a parsed iFlow (Ref_Structure): the same details and the local processes', async () => {
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Structure.zip')))
    const model = flowDiagram.fromParsed(parsed)
    expect(model.steps.map((s) => [s.name, s.detail || '', !!s.perItem])).toEqual([
      ['CM_SetBody', '', false],
      ['ITSPL_Orders', 'Iterating //order', false],
      ['PC_HandleOrder', '→ LIP_HandleOrder', true],
      ['GA_Orders', 'into /orders', false],
      ['LPC_FetchPages', '→ LIP_FetchPage, loop max 5', false],
      ['GSPL_Orders', 'General /orders/order', false],
      ['GA_Combine', 'Combine', false]
    ])
    expect(model.locals.map((lp) => lp.name).sort()).toEqual(['LIP_FetchPage', 'LIP_HandleOrder'])
  })
})

describe('flow diagram: SOAP and Mail receivers (phase 3)', () => {
  const soap = { type: 'requestReplySoap', url: 'http://s4dummy/x', authType: 'Basic', credentialName: 'C', proxyType: 'On-Premise' }
  const mail = { type: 'sendMail', server: 'smtp.example.com:587', credentialName: 'C', from: 'a@example.com', to: 'b@example.com', subject: 'Hi' }
  test('from a spec and from a parsed iFlow: type, detail and receiver', async () => {
    const model = flowDiagram.fromSpec({ trigger: { type: 'timer', mode: 'once' }, steps: [soap, mail], end: { type: 'none' } })
    expect(model.steps.map((s) => [s.name, s.detail, s.receiver.name, s.receiver.detail])).toEqual([
      ['Request Reply 1', 'SOAP 1.x', 'Receiver1', 'http://s4dummy/x'],
      ['Send 1', 'to b@example.com', 'Receiver2', 'smtp.example.com:587']
    ])
    expect(flowDiagram.toHtml(model)).toContain('Request Reply (SOAP)')
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Receivers.zip')))
    const steps = flowDiagram.fromParsed(parsed).steps
    expect(steps.find((s) => s.name === 'RR_Soap')).toMatchObject({ type: 'requestReplySoap', detail: 'SOAP 1.x', receiver: { detail: '{{RR_Soap_Address}}' } })
    expect(steps.find((s) => s.name === 'SND_Alert')).toMatchObject({ type: 'sendMail', detail: 'to {{Mail_To}}', receiver: { detail: '{{Mail_Server}}' } })
  })
})

describe('flow diagram: multicasts (phase 9)', () => {
  test('from a spec: default names, the mode and the branches up to the Join', () => {
    const cm = (name) => ({ type: 'contentModifier', name })
    const model = flowDiagram.fromSpec({
      trigger: { type: 'timer', mode: 'once' },
      steps: [{ type: 'multicast', mode: 'sequential', branches: [{ steps: [cm('A')] }, { name: 'Other', steps: [{ type: 'router', name: 'RT', expressionType: 'NonXML', routes: [{ name: 'R', condition: 'x', steps: [cm('B')], end: {} }, { name: 'D', default: true }] }, cm('C')] }] }, { type: 'gather', name: 'GA' }],
      end: { type: 'none' }
    })
    expect(model.steps[0]).toMatchObject({ name: 'Sequential Multicast 1', detail: 'Sequential', branches: [{ name: 'Branch 1', steps: ['A'] }, { name: 'Other', steps: ['RT', 'B', 'C'] }] })
    expect(flowDiagram.toHtml(model)).toContain('Other</span> RT → B → C → Join')
  })

  test('from a parsed iFlow (Ref_Multicast)', async () => {
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Multicast.zip')))
    const steps = flowDiagram.fromParsed(parsed).steps
    expect(steps.map((s) => [s.name, s.type, s.detail || ''])).toEqual([
      ['CM_SetBody', 'contentModifier', ''],
      ['MC_Parallel', 'multicast', 'Parallel'],
      ['GA_Parallel', 'gather', 'Combine'],
      ['MC_Sequential', 'multicast', 'Sequential'],
      ['GA_Sequential', 'gather', 'Combine']
    ])
    expect(steps[1].branches).toEqual([{ name: 'Branch 1', steps: ['CM_BranchA'] }, { name: 'Branch 2', steps: ['RT_Branch', 'CM_BranchB'] }])
  })
})

describe('flow diagram: mappings (phase 4)', () => {
  test('the type and the artifact or file', async () => {
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Mapping.zip')))
    const steps = flowDiagram.fromParsed(parsed).steps
    expect(steps.map((s) => [s.name, s.type, s.detail || ''])).toEqual([
      ['CM_SetBody', 'contentModifier', ''],
      ['MM_UseArtifact', 'messageMapping', 'MM_DummyOrderToNotif'],
      ['XSLT_Dummy', 'xsltMapping', 'DummyTransform.xsl'],
      ['MM_Inline', 'messageMapping', 'MM_Inline_OrderToNotif.mmap']
    ])
  })
})

describe('flow diagram: senders (phase 5)', () => {
  test('a SOAP sender shows as SOAP with its address, from a spec and from the parsed reference', async () => {
    const model = flowDiagram.fromSpec({ trigger: { type: 'soapSender', address: '/dummy/soap' }, steps: [], end: { type: 'none' } })
    expect(model.trigger).toEqual({ kind: 'https', label: 'SOAP', detail: '/dummy/soap' })
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Sender_SOAP.zip')))
    expect(flowDiagram.fromParsed(parsed).trigger).toMatchObject({ label: 'SOAP', detail: '/dummy/soap' })
  })
  test('a JMS sender shows as JMS with its queue', async () => {
    expect(flowDiagram.fromSpec({ trigger: { type: 'jmsSender', queue: 'ORDERS_IN' }, steps: [], end: { type: 'none' } }).trigger).toEqual({ kind: 'other', label: 'JMS', detail: 'ORDERS_IN' })
  })
  test('an SFTP sender shows as SFTP with its host and directory', async () => {
    expect(flowDiagram.fromSpec({ trigger: { type: 'sftpSender', host: 'sftp.example.com:22', directory: '/in' }, steps: [], end: { type: 'none' } }).trigger).toEqual({ kind: 'other', label: 'SFTP', detail: 'sftp.example.com:22 /in' })
  })
  test('ProcessDirect receivers (phase 6): the step and the end show their address, also from a parsed export', async () => {
    const model = flowDiagram.fromSpec({ trigger: { type: 'timer', mode: 'once' }, steps: [{ type: 'requestReplyProcessDirect', name: 'RR', system: 'RCV_PD', address: '/a' }], end: { type: 'processDirectReceiver', system: 'RCV_N', address: '/b' } })
    expect(model.steps[0]).toMatchObject({ detail: 'ProcessDirect', receiver: { name: 'RCV_PD', detail: '/a' } })
    // without a name it is a Request Reply, as in CPI
    expect(flowDiagram.fromSpec({ trigger: { type: 'timer', mode: 'once' }, steps: [{ type: 'requestReplyProcessDirect', address: '/a' }], end: { type: 'none' } }).steps[0].name).toBe('Request Reply 1')
    expect(model.end.receiver).toEqual({ name: 'RCV_N', detail: 'ProcessDirect /b' })
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Receiver_ProcessDirect.zip')))
    const fromParsed = flowDiagram.fromParsed(parsed)
    expect(fromParsed.steps.find((s) => s.name === 'RR_CallOrders')).toMatchObject({ detail: 'ProcessDirect', receiver: { name: 'RCV_PD_Orders', detail: '/dummy/pd/orders' } })
    expect(fromParsed.end.receiver).toEqual({ name: 'RCV_PD_Notify', detail: 'ProcessDirect {{PD_Notify_Address}}' })
  })
  test('SFTP receivers (phase 6): the step shows its file name, the receiver its host, also from a parsed export', async () => {
    const model = flowDiagram.fromSpec({ trigger: { type: 'timer', mode: 'once' }, steps: [{ type: 'sendSftp', system: 'RCV_SFTP', host: 'sftp.example.com', directory: '/out', fileName: 'a.xml', authentication: 'userPassword', credentialName: 'C' }], end: { type: 'none' } })
    expect(model.steps[0]).toMatchObject({ type: 'sendSftp', name: 'Send 1', detail: 'a.xml', receiver: { name: 'RCV_SFTP', detail: 'SFTP sftp.example.com' } })
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Receiver_SFTP.zip')))
    const fromParsed = flowDiagram.fromParsed(parsed)
    expect(fromParsed.steps.find((s) => s.name === 'SND_SftpKey')).toMatchObject({ detail: 'order_${date:now:yyyyMMddHHmmss}.xml', receiver: { name: 'RCV_SFTP_Key', detail: 'SFTP sftp.example.com:22' } })
    expect(fromParsed.steps.find((s) => s.name === 'SND_SftpPw')).toMatchObject({ detail: '{{SFTP_Out_FileName}}', receiver: { name: 'RCV_SFTP_Pw', detail: 'SFTP {{SFTP_Out_Address}}' } })
  })
  test('OData V2 receivers (phase 6): the step shows the operation and entity set, the receiver its URL, also from a parsed export', async () => {
    const model = flowDiagram.fromSpec({ trigger: { type: 'timer', mode: 'once' }, steps: [{ type: 'requestReplyOData', system: 'RCV_O', url: 'https://o.example.com/Z_SRV', operation: 'query', resourcePath: 'Products', authType: 'Basic', credentialName: 'C', proxyType: 'Internet' }], end: { type: 'none' } })
    expect(model.steps[0]).toMatchObject({ type: 'requestReplyOData', name: 'Request Reply 1', detail: 'OData Query Products', receiver: { name: 'RCV_O', detail: 'https://o.example.com/Z_SRV' } })
    const fromParsed = flowDiagram.fromParsed(await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Receiver_OData.zip'))))
    expect(fromParsed.steps.find((s) => s.name === 'RR_ODataCreate')).toMatchObject({ detail: 'OData Create Products', receiver: { name: 'RCV_OData_Create', detail: '{{OData_Address}}' } })
    expect(fromParsed.steps.find((s) => s.name === 'RR_ODataQuery')).toMatchObject({ detail: 'OData Query Products', receiver: { name: 'RCV_OData_Query', detail: 'https://odata.example.com/sap/opu/odata/sap/ZDUMMY_SRV' } })
  })
  test('a ProcessDirect sender shows as ProcessDirect with its address', async () => {
    expect(flowDiagram.fromSpec({ trigger: { type: 'processDirectSender', address: '/dummy/pd/orders' }, steps: [], end: { type: 'none' } }).trigger).toEqual({ kind: 'other', label: 'ProcessDirect', detail: '/dummy/pd/orders' })
    const parsed = await parse(fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/reference/Ref_Sender_ProcessDirect.zip')))
    expect(flowDiagram.fromParsed(parsed).trigger).toMatchObject({ label: 'ProcessDirect', detail: '/dummy/pd/orders' })
  })
})
