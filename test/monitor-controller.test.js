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
  const api = { q: () => '', get: jest.fn(async (url) => (url.startsWith('/RuntimeArtifacts') ? runtime : [])) }
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
