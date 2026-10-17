jest.mock('../srv/lib/cpi-client', () => ({
  listPackages: jest.fn(),
  listIflows: jest.fn(),
  listRuntimeArtifacts: jest.fn(),
  listMessageLogs: jest.fn()
}))
const cpi = require('../srv/lib/cpi-client')
const { getStats, mapLimit } = require('../srv/lib/stats')

beforeEach(() => {
  jest.clearAllMocks()
  cpi.listPackages.mockResolvedValue([{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'Partner' }])
  cpi.listIflows.mockImplementation(async (id) => {
    if (id === 'Partner') throw Object.assign(new Error('forbidden'), { status: 403 })
    return { A: [1, 2], B: [1], C: [] }[id].map((n) => ({ id: `${id}${n}` }))
  })
  cpi.listRuntimeArtifacts.mockResolvedValue([
    { id: 'A1', type: 'INTEGRATION_FLOW', status: 'STARTED' },
    { id: 'A2', type: 'INTEGRATION_FLOW', status: 'ERROR' },
    { id: 'VM', type: 'VALUE_MAPPING', status: 'STARTED' }
  ])
  cpi.listMessageLogs.mockResolvedValue([{}, {}])
})

test('counts iFlows by looping over all packages and caches the result for 30s', async () => {
  const s = await getStats({ fresh: true })
  expect(s).toMatchObject({ packages: 4, iflows: 3, packagesNotReadable: 1, deployed: 2, started: 1, error: 1, failedMessages24h: 2 })
  expect(cpi.listIflows).toHaveBeenCalledTimes(4)

  await getStats()
  expect(cpi.listPackages).toHaveBeenCalledTimes(1) // served from cache
  await getStats({ fresh: true })
  expect(cpi.listPackages).toHaveBeenCalledTimes(2)
})

test('concurrent calls share one computation', async () => {
  await Promise.all([getStats({ fresh: true }), getStats({ fresh: true }), getStats({ fresh: true })])
  expect(cpi.listPackages).toHaveBeenCalledTimes(1)
})

test('missing monitoring access does not break the KPIs', async () => {
  cpi.listMessageLogs.mockRejectedValue(new Error('403'))
  expect(await getStats({ fresh: true })).toMatchObject({ iflows: 3, failedMessages24h: null })
})

test('mapLimit keeps order and limits parallelism', async () => {
  let active = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return n * 10
  })
  expect(out).toEqual([10, 20, 30, 40, 50, 60])
  expect(peak).toBe(2)
})
