/** Agent tool getMessageLogs: the iFlow filter reaches the CPI client */
jest.mock('../srv/lib/cpi-client', () => ({ MESSAGE_STATUSES: ['FAILED'], listMessageLogs: jest.fn(async () => []) }))

const cpi = require('../srv/lib/cpi-client')
const { definitions, execute } = require('../srv/agent/tools')

test('getMessageLogs offers iflowId and passes it on', async () => {
  const def = definitions.find((d) => d.function.name === 'getMessageLogs')
  expect(def.function.parameters.properties.iflowId).toEqual({ type: 'string' })
  await execute('getMessageLogs', JSON.stringify({ iflowId: 'Test03_Northwind', status: 'FAILED' }), {})
  expect(cpi.listMessageLogs).toHaveBeenCalledWith({ iflowId: 'Test03_Northwind', status: 'FAILED', sinceHours: 24, top: 20 })
})
