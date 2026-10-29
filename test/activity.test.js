/**
 * Activity page: the writes summary is counted on the server (the page never loads the whole log to
 * count it), the log is paged and filtered on the server, and the charts get one column per day.
 */
const path = require('path')
const cds = require('@sap/cds')
const { GET } = cds.test(path.join(__dirname, '..'), '--in-memory')

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

describe('GET /api/activitySummary', () => {
  beforeAll(() =>
    INSERT.into('iflowpilot.AuditLog').entries([
      { action: 'CREATE_IFLOW', targetType: 'Iflow', targetId: 'Orders_In', status: 'SUCCESS', user: 'anna', createdAt: daysAgo(0.1) },
      { action: 'CREATE_IFLOW', targetType: 'Iflow', targetId: 'Stock', status: 'SUCCESS', user: 'anna', createdAt: daysAgo(0.2) },
      { action: 'DEPLOY_IFLOW', targetType: 'Iflow', targetId: 'Orders_In', status: 'FAILED', user: 'bob', createdAt: daysAgo(2) },
      { action: 'DEPLOY_IFLOW', targetType: 'Iflow', targetId: 'Old', status: 'SUCCESS', user: 'bob', createdAt: daysAgo(40) }
    ])
  )

  test('counts writes of the period per day and per action, successful and failed', async () => {
    const { data } = await GET('/api/activitySummary(days=30)')
    expect(data).toMatchObject({ days: 30, totals: { writes: 3, failed: 1 } })
    expect(data.byAction).toEqual([
      { action: 'CREATE_IFLOW', success: 2, failed: 0, count: 2 },
      { action: 'DEPLOY_IFLOW', success: 0, failed: 1, count: 1 }
    ])
    expect(data.byDay.map((d) => d.success + d.failed).reduce((a, b) => a + b)).toBe(3)
    expect(data.byDay.map((d) => d.day)).toEqual([...data.byDay.map((d) => d.day)].sort()) // oldest first
  })

  test('a longer period includes older writes', async () => {
    expect((await GET('/api/activitySummary(days=90)')).data.totals.writes).toBe(4)
  })

  test('the log is paged and filtered on the server (period, action, result, search)', async () => {
    const since = daysAgo(30)
    const q = (f, extra = '') => GET(`/api/AuditLog?$filter=${encodeURIComponent(f)}&$orderby=createdAt%20desc${extra}`)
    expect((await q(`createdAt ge ${since}`, '&$top=1&$skip=1')).data.map((a) => a.targetId)).toEqual(['Stock'])
    expect((await q(`createdAt ge ${since} and action eq 'DEPLOY_IFLOW' and status eq 'FAILED'`)).data.map((a) => a.targetId)).toEqual(['Orders_In'])
    expect((await q(`createdAt ge ${since} and (contains(tolower(targetId),'orders') or contains(tolower(user),'orders'))`)).data).toHaveLength(2)
  })
})

describe('Activity controller', () => {
  function factoryOf(file) {
    let factory
    global.sap = { ui: { define: (_deps, f) => (factory = f) } }
    jest.isolateModules(() => require(file))
    delete global.sap
    return factory
  }
  function JSONModel(data) {
    this.data = data
    const at = (p) => p.split('/').filter(Boolean)
    this.getProperty = (p) => at(p).reduce((o, k) => (o == null ? undefined : o[k]), this.data)
    this.setProperty = (p, v) => {
      const keys = at(p)
      const last = keys.pop()
      keys.reduce((o, k) => (o[k] ??= {}), this.data)[last] = v
    }
  }
  function controller(answers) {
    const calls = []
    const api = { get: jest.fn(async (url) => (calls.push(url), answers(url))), q: (o) => `?${new URLSearchParams(o)}` }
    const charts = { column: jest.fn(async () => ({})) }
    const BaseController = { extend: (_n, proto) => proto }
    const ctl = Object.create(factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Activity.controller.js'))(BaseController, JSONModel, null, null, null, api, charts))
    const models = {}
    Object.assign(ctl, {
      setModel: (m, n) => (models[n] = m),
      getModel: (n) => models[n],
      byId: (id) => ({ id }),
      getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }) }),
      formatter: { humanize: (s) => s.toLowerCase(), tokens: String }
    })
    ctl.onInit()
    return { ctl, view: models.view, calls, charts }
  }

  test('two column charts (AI usage); tokens per day on a time axis', () => {
    const { charts } = controller(() => ({}))
    expect(charts.column.mock.calls.map(([c, o]) => [c.id, !!o.time])).toEqual([
      ['tokensByDayChart', true],
      ['tokensByModelChart', false]
    ])
  })

  test('the action filter offers the actions of the period', async () => {
    const { ctl, view } = controller((url) => (url.startsWith('/activitySummary') ? { totals: { writes: 2, failed: 0 }, byDay: [], byAction: [{ action: 'DEPLOY_IFLOW' }, { action: 'CREATE_IFLOW' }] } : {}))
    await ctl.loadSummary()
    expect(view.getProperty('/actions').map((a) => a.key)).toEqual(['', 'CREATE_IFLOW', 'DEPLOY_IFLOW'])
  })

  test('every day of the period gets a column (zeros on days without data); model names without the provider', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { ctl, view } = controller((url) =>
      url.startsWith('/usage') ? { totals: { requests: 1 }, byDay: [{ day: today, inputTokens: 5, outputTokens: 1 }], byModel: [{ model: 'nvidia/nemotron-x', inputTokens: 5, outputTokens: 1 }] } : []
    )
    view.setProperty('/days', '7')
    await ctl.loadUsage()
    const days = view.getProperty('/charts/tokensByDay')
    expect(days).toHaveLength(7)
    expect(days.at(-1)).toMatchObject({ day: today, inputTokens: 5, outputTokens: 1 })
    expect(days[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    expect(view.getProperty('/charts/tokensByModel')).toEqual([{ model: 'nemotron-x', inputTokens: 5, outputTokens: 1 }])
  })

  test('the log asks the server for one page with the period, filters and search; Load more continues', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ ID: `a${i}` }))
    const { ctl, view, calls } = controller((url) => (url.startsWith('/AuditLog') ? page : {}))
    Object.assign(view.data, { action: 'DEPLOY_IFLOW', status: 'FAILED', search: "O'Brien" })
    await ctl.loadLog()
    const q = new URLSearchParams(calls.at(-1).split('?')[1])
    expect(q.get('$top')).toBe('50')
    expect(q.get('$filter')).toMatch(/^createdAt ge \S+ and action eq 'DEPLOY_IFLOW' and status eq 'FAILED' and \(contains\(tolower\(targetId\),'o''brien'\)/)
    expect(view.getProperty('/more')).toBe(true)
    await ctl.onLoadMore()
    expect(new URLSearchParams(calls.at(-1).split('?')[1]).get('$skip')).toBe('50')
    expect(view.getProperty('/entries')).toHaveLength(100)
  })
})
