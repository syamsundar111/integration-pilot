/**
 * CPI client: message processing logs, paged with $skip (Monitor page "Load more"; CPI keeps the
 * logs for a limited time, 30 days by default).
 */
jest.mock('@sap-cloud-sdk/http-client', () => ({ executeHttpRequest: jest.fn() }))
jest.mock('@sap-cloud-sdk/connectivity', () => ({ getDestination: jest.fn() }))
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const cpi = require('../srv/lib/cpi-client')

beforeEach(() => {
  executeHttpRequest.mockReset()
  executeHttpRequest.mockResolvedValue({ data: { d: { results: [] } } })
  cpi.invalidateCache()
})
const lastUrl = () => decodeURIComponent(executeHttpRequest.mock.calls.at(-1)[1].url)

describe('listMessageLogs', () => {
  test('first page: newest first, top, time window; no $skip', async () => {
    await cpi.listMessageLogs({ top: 100, sinceHours: 720 })
    expect(lastUrl()).toMatch(/^\/api\/v1\/MessageProcessingLogs\?\$orderby=LogEnd desc&\$top=100&\$filter=LogStart gt datetime'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d'$/)
  })

  test('next page: $skip with the number already loaded', async () => {
    await cpi.listMessageLogs({ status: 'FAILED', top: 100, skip: 200, sinceHours: 24 })
    expect(lastUrl()).toMatch(/\$top=100&\$skip=200&\$filter=Status eq 'FAILED' and LogStart gt/)
  })

  test('a negative or invalid skip is ignored', async () => {
    await cpi.listMessageLogs({ top: 10, skip: -5 })
    expect(lastUrl()).not.toContain('$skip')
  })
})
