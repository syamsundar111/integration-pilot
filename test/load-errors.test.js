/**
 * A failed load shows its error, not an empty state that reads as "all good" (bug: the Dashboard's
 * failed-messages card said "Nothing failed in the last 24 hours" when CPI could not be asked; the
 * iFlow Parameters tab said "No externalized parameters"; Activity's AI usage failed silently).
 * Controllers are loaded with stubbed UI5 dependencies, as in monitor-controller.test.js.
 */
const path = require('path')

function factoryOf(name) {
  let factory
  global.sap = { ui: { define: (_deps, f) => (factory = f) } }
  jest.isolateModules(() => require(path.join(__dirname, `../app/integration-pilot/webapp/controller/${name}.controller.js`)))
  delete global.sap
  return factory
}

/** Minimal JSONModel */
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

/** api stub: `failing` lists URL prefixes that fail (changeable during a test) */
function apiStub(answers) {
  const failing = new Set()
  const get = jest.fn(async (url) => {
    for (const f of failing) if (url.startsWith(f)) throw Object.assign(new Error('CPI not reachable'), { hint: 'check the destination' })
    const key = Object.keys(answers).find((k) => url.startsWith(k))
    return key ? answers[key] : []
  })
  return { api: { get, q: () => '', seg: encodeURIComponent }, failing }
}

function controller(name, deps) {
  const BaseController = { extend: (_n, proto) => proto }
  const ctl = Object.create(factoryOf(name)(BaseController, JSONModel, ...deps))
  const models = {}
  Object.assign(ctl, {
    setModel: (m, n) => (models[n] = m),
    getModel: (n) => models[n],
    getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }) }),
    showError: jest.fn()
  })
  ctl.onInit()
  return { ctl, view: models.view }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('Dashboard cards', () => {
  const answers = { '/stats': {}, '/messageLogs': [{ messageGuid: 'm1' }], '/Proposals': [{ ID: 'p1' }] }

  test('failed loads give an error per card, not an empty list; the next good load clears it', async () => {
    const { api, failing } = apiStub(answers)
    const { ctl, view } = controller('Dashboard', [api])
    failing.add('/messageLogs').add('/Proposals')
    await ctl.load(false)
    expect(view.getProperty('/failedError')).toBe('CPI not reachable — check the destination')
    expect(view.getProperty('/proposalsError')).toBe('CPI not reachable — check the destination')
    expect(view.getProperty('/failedBusy')).toBe(false)
    failing.clear()
    await ctl.load(true)
    expect(view.getProperty('/failedError')).toBeNull()
    expect(view.getProperty('/proposalsError')).toBeNull()
    expect(view.getProperty('/failed')).toEqual([{ messageGuid: 'm1' }])
  })

  test('one card failing does not affect the other', async () => {
    const { api, failing } = apiStub(answers)
    const { ctl, view } = controller('Dashboard', [api])
    failing.add('/messageLogs')
    await ctl.load(false)
    expect(view.getProperty('/failedError')).toMatch(/CPI not reachable/)
    expect(view.getProperty('/proposalsError')).toBeNull()
    expect(view.getProperty('/proposals')).toEqual([{ ID: 'p1' }])
  })
})

describe('iFlow Parameters tab', () => {
  const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }

  test('a failed load shows the error, not "no externalized parameters"', async () => {
    const { api, failing } = apiStub({ '/Iflows/A/configurations': [{ key: 'K', value: 'v' }] })
    const { ctl, view } = controller('Iflows', [api, flowDiagram])
    failing.add('/Iflows/A/configurations')
    view.setProperty('/iflowId', 'A')
    await ctl.loadConfigs()
    expect(view.getProperty('/configs')).toEqual([])
    expect(view.getProperty('/configsError')).toBe('CPI not reachable — check the destination')
    failing.clear()
    await ctl.loadConfigs()
    expect(view.getProperty('/configsError')).toBeNull()
    expect(view.getProperty('/configs').map((c) => c.key)).toEqual(['K'])
  })

  test("a late failure for the previous iFlow does not show under the current one", async () => {
    const { api, failing } = apiStub({})
    const { ctl, view } = controller('Iflows', [api, flowDiagram])
    failing.add('/Iflows/A/')
    view.setProperty('/iflowId', 'A')
    const late = ctl.loadConfigs()
    view.setProperty('/iflowId', 'B')
    await late
    expect(view.getProperty('/configsError')).toBeNull()
  })
})

describe('Activity AI usage', () => {
  test('a failed load shows the error and clears the old numbers; the audit log still loads', async () => {
    const usage = { totals: { requests: 3, failed: 1 }, byDay: [], byModel: [] }
    const { api, failing } = apiStub({ '/usage': usage, '/AuditLog': [{ action: 'deploy' }] })
    const { ctl, view } = controller('Activity', [null, null, null, api])
    ctl.formatter = { humanize: (s) => s }
    ctl.applyFilter = () => {}
    await ctl.loadUsage()
    expect(view.getProperty('/usage/totals/requests')).toBe(3)
    failing.add('/usage')
    ctl.onRefresh()
    await flush()
    expect(view.getProperty('/usageError')).toBe('CPI not reachable — check the destination')
    expect(view.getProperty('/usage/totals/requests')).toBeUndefined()
    expect(view.getProperty('/entries')).toEqual([{ action: 'deploy' }])
    expect(ctl.showError).not.toHaveBeenCalled()
    failing.clear()
    await ctl.loadUsage()
    expect(view.getProperty('/usageError')).toBeNull()
  })
})
