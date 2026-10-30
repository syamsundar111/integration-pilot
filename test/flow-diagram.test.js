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
