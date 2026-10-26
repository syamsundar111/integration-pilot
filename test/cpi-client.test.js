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

describe('listMessageLogs: one iFlow or a name search (filters checked on a real tenant)', () => {
  test('iflowId: the exact iFlow', async () => {
    await cpi.listMessageLogs({ iflowId: 'Test03_Northwind', sinceHours: 24 })
    expect(lastUrl()).toMatch(/\$filter=IntegrationArtifact\/Id eq 'Test03_Northwind' and LogStart gt/)
  })

  test('search: part of the name, any case; quotes are escaped', async () => {
    await cpi.listMessageLogs({ search: '  NorthWind ' })
    expect(lastUrl()).toMatch(/\$filter=substringof\('northwind',tolower\(IntegrationFlowName\)\)$/)
    await cpi.listMessageLogs({ search: "o'brien" })
    expect(lastUrl()).toContain("substringof('o''brien',tolower(IntegrationFlowName))")
  })

  test('iflowId wins over search', async () => {
    await cpi.listMessageLogs({ iflowId: 'A', search: 'b' })
    expect(lastUrl()).toMatch(/IntegrationArtifact\/Id eq 'A'/)
    expect(lastUrl()).not.toContain('substringof')
  })
})

describe('updatePackage', () => {
  test('a change without description keeps the current one, with its formatting (PUT replaces the entity)', async () => {
    const current = { Id: 'P', Name: 'P', ShortText: 'P', Version: '1.0.0', Description: '<p>Orders <b>inbound</b></p>' }
    executeHttpRequest.mockImplementation(async (_dest, req) => ({ data: { d: req.method === 'PUT' ? {} : current }, headers: { 'x-csrf-token': 't' } }))
    await cpi.updatePackage('P', { name: 'P', shortText: 'P', description: undefined, version: '1.0.1' })
    const put = executeHttpRequest.mock.calls.map(([, req]) => req).find((req) => req.method === 'PUT')
    expect(put.data).toMatchObject({ Version: '1.0.1', Description: '<p>Orders <b>inbound</b></p>' })
  })
})
