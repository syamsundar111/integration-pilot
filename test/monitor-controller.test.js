/**
 * Monitor page filters (bug: after the Dashboard's "In error" tile, the "Deployed / started" tile
 * still showed only errors; the same for the failed-messages card and the log filter).
 * The controller is loaded with stubbed UI5 dependencies.
 */
const path = require('path')

function factoryOf(file) {
  let factory
  global.sap = { ui: { define: (_deps, f) => (factory = f) } }
  jest.isolateModules(() => require(file))
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

function monitor() {
  const runtime = [
    { id: 'a', name: 'A', status: 'STARTED' },
    { id: 'b', name: 'B', status: 'ERROR' }
  ]
  const api = {
    q: (o) => `?${new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined))}`,
    // message logs: 230 on the tenant, served in pages
    get: jest.fn(async (url) => {
      if (url.startsWith('/RuntimeArtifacts')) return runtime
      if (!url.startsWith('/messageLogs')) return []
      const q = new URLSearchParams(url.split('?')[1])
      const skip = Number(q.get('skip') || 0)
      const top = Number(q.get('top'))
      return Array.from({ length: Math.max(0, Math.min(top, 230 - skip)) }, (_, i) => ({ messageGuid: `m${skip + i}` }))
    })
  }
  const BaseController = { extend: (_n, proto) => proto }
  const proto = factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Monitor.controller.js'))(BaseController, JSONModel, null, null, null, null, api)
  const ctl = Object.create(proto)
  let matched
  const models = {}
  Object.assign(ctl, {
    setModel: (m, name) => (models[name] = m),
    getModel: (name) => models[name],
    getRouter: () => ({ getRoute: () => ({ attachPatternMatched: (fn) => (matched = fn) }), attachRouteMatched: () => {} })
  })
  ctl.onInit()
  const open = async (query) => {
    matched({ getParameter: () => (query ? { '?query': query } : {}) })
    await new Promise((r) => setImmediate(r))
  }
  return { ctl, open, view: models.view, api }
}

afterEach(() => jest.useRealTimers())

describe('Monitor page filters follow the link that opened it', () => {
  test('"In error" tile, then "Deployed / started" tile: all artifacts again', async () => {
    const { open, view, ctl } = monitor()
    await open({ status: 'ERROR' })
    expect(view.getProperty('/runtimeRows').map((r) => r.id)).toEqual(['b'])
    await open() // the Deployed / started tile has no filter
    expect(view.getProperty('/status')).toBe('ALL')
    expect(view.getProperty('/runtimeRows').map((r) => r.id)).toEqual(['b', 'a'])
    ctl.onExit()
  })

  test('failed-messages card, then a plain link: all message statuses and 24 hours again', async () => {
    const { open, view, api, ctl } = monitor()
    await open({ logs: 'FAILED' })
    expect(view.getProperty('/logStatus')).toBe('FAILED')
    view.setProperty('/hours', '168') // the user widened the window
    await open()
    expect(view.getProperty('/logStatus')).toBe('')
    expect(view.getProperty('/hours')).toBe('24')
    expect(api.get).toHaveBeenLastCalledWith(expect.stringMatching(/^\/messageLogs/))
    ctl.onExit()
  })
})

describe('Monitor page: message logs over 30 days, loaded in pages', () => {
  test('100 at a time; "Load more" continues where the list ends and stops after a short page', async () => {
    const { open, view, ctl, api } = monitor()
    await open({ hours: '720' })
    expect(view.getProperty('/hours')).toBe('720')
    expect(view.getProperty('/logs')).toHaveLength(100)
    expect(view.getProperty('/logsMore')).toBe(true)
    await ctl.onLoadMoreLogs()
    expect(api.get).toHaveBeenLastCalledWith(expect.stringMatching(/skip=100/))
    expect(view.getProperty('/logs')).toHaveLength(200)
    await ctl.onLoadMoreLogs()
    expect(view.getProperty('/logs').map((l) => l.messageGuid).slice(-1)).toEqual(['m229'])
    expect(view.getProperty('/logs')).toHaveLength(230)
    expect(view.getProperty('/logsMore')).toBe(false) // 30 < 100: the end
    // a filter change starts over
    view.setProperty('/logStatus', 'FAILED')
    await ctl.loadLogs()
    expect(view.getProperty('/logs')).toHaveLength(100)
    ctl.onExit()
  })
})

