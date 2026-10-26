/**
 * Agent tools around updates of existing iFlows (review findings): reading the current
 * content must not fall back to defaults that an approval would then write to the tenant.
 */
jest.mock('../srv/lib/cpi-client', () => ({
  MESSAGE_STATUSES: ['FAILED'],
  getIflow: jest.fn(async (id) => ({ id, name: id, packageId: 'PilotReference' })),
  downloadIflowZip: jest.fn(),
  getConfigurations: jest.fn()
}))

const cpi = require('../srv/lib/cpi-client')
const { execute } = require('../srv/agent/tools')
const { build } = require('../srv/iflow-builder/builder')
const sample = require('../srv/iflow-builder/samples/Pilot_Test_1.json')

beforeAll(async () => {
  const zip = Buffer.from((await build({ ...sample, id: 'Orders_To_ERP' })).zipBase64, 'base64')
  cpi.downloadIflowZip.mockResolvedValue(zip)
})

test('getIflowSpec: parameters that cannot be read are an error, not the defaults (an approval would write them)', async () => {
  cpi.getConfigurations.mockRejectedValueOnce(Object.assign(new Error('CPI: 503 Service Unavailable'), { status: 503 }))
  const result = JSON.parse(await execute('getIflowSpec', JSON.stringify({ iflowId: 'Orders_To_ERP' }), {}))
  expect(result.error).toMatchObject({ code: 'CONFIGURATIONS_UNREADABLE', message: expect.stringContaining("current parameter values of iFlow 'Orders_To_ERP' could not be read") })
  expect(result.spec).toBeUndefined()
})

test('writeScript refuses a hard-coded secret, like inline code (review: the check never ran for written scripts)', async () => {
  const code = 'import com.sap.gateway.ip.core.customdev.util.Message\ndef Message processData(Message message) {\n  def password = "hunter2"\n  return message\n}\n'
  const result = JSON.parse(await execute('writeScript', JSON.stringify({ fileName: 'callErp', code }), { user: { id: 'u' }, sessionId: 's' }))
  expect(JSON.stringify(result)).toContain('SECRET')
  expect(result.stored).toBeUndefined()
})

describe('spec arguments (review: a stray "id" next to useDraftSpec replaced the draft with a stub)', () => {
  const { normalizeSpecArgs } = require('../srv/agent/tools')

  test('useDraftSpec with a stray id: the draft is used, no stub spec', () => {
    expect(normalizeSpecArgs({ useDraftSpec: true, id: 'Orders_To_ERP' })).toEqual({ spec: undefined, useDraftSpec: true, useValidatedSpec: false })
    expect(normalizeSpecArgs({ useValidatedSpec: 'true', id: 'X' }).spec).toBeUndefined()
  })

  test('a complete spec without the wrapper is still accepted; an id alone is not a spec', () => {
    const spec = { id: 'A', trigger: { type: 'httpsSender', address: '/a' }, steps: [] }
    expect(normalizeSpecArgs(spec).spec).toEqual(spec)
    expect(normalizeSpecArgs({ id: 'A' }).spec).toBeUndefined()
    expect(normalizeSpecArgs({ spec: JSON.stringify(spec) }).spec).toEqual(spec)
  })
})
