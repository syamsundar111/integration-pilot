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
    byId: () => null, // no rendered panels in the test: scrolling is skipped
    setModel: (m, name) => (models[name] = m),
    getModel: (name) => models[name],
    getRouter: () => ({ getRoute: () => ({ attachPatternMatched: (fn) => (matched = fn) }), attachRouteMatched: () => {} })
  })
  ctl.onInit()
  started.push(ctl)
  const open = async (query) => {
    matched({ getParameter: () => (query ? { '?query': query } : {}) })
    await new Promise((r) => setImmediate(r))
  }
  return { ctl, open, view: models.view, api }
}

// every Monitor stops its auto-refresh timer, also when a test fails before its own onExit()
const started = []
afterEach(() => {
  while (started.length) started.pop().onExit()
  jest.useRealTimers()
})

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

describe('Monitor page: collapsible sections', () => {
  const store = {}
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) }
  })
  afterEach(() => delete global.localStorage)

  test('both sections start open; a collapsed section is remembered for the next visit', async () => {
    const first = monitor()
    expect(first.view.getProperty('/open')).toEqual({ artifacts: true, logs: true })
    first.ctl.onArtifactsToggle({ getParameter: () => false })
    first.ctl.onExit()
    const next = monitor() // the page opened again later
    expect(next.view.getProperty('/open')).toEqual({ artifacts: false, logs: true })
    next.ctl.onExit()
  })

  test('a link opens the section it points to, even if it was collapsed', async () => {
    store['integrationPilot.monitor.open'] = JSON.stringify({ artifacts: false, logs: false })
    const { open, view, ctl } = monitor()
    await open({ logs: 'FAILED' }) // Dashboard: failed messages
    expect(view.getProperty('/open/logs')).toBe(true)
    await open({ status: 'ERROR' }) // Dashboard: in error
    expect(view.getProperty('/open/artifacts')).toBe(true)
    ctl.onExit()
  })

  test('the logs header counts the failed messages among those loaded', async () => {
    const { open, view, api, ctl } = monitor()
    api.get.mockImplementation(async (url) => (url.startsWith('/messageLogs') ? [{ status: 'FAILED' }, { status: 'COMPLETED' }, { status: 'FAILED' }] : []))
    await open()
    expect(view.getProperty('/logsFailed')).toBe(2)
    ctl.onExit()
  })
})


describe('iFlow search and the Messages button', () => {
  const press = (ctl, row) => ({ getSource: () => ({ getBindingContext: () => ({ getObject: () => row }) }) })
  const logQuery = (api) => new URLSearchParams(api.get.mock.calls.filter(([u]) => u.startsWith('/messageLogs')).at(-1)[0].split('?')[1])

  test('artifact search narrows the rows by name or ID, together with the status filter', async () => {
    const { open, view, ctl } = monitor()
    await open()
    ctl.onArtifactSearch({ getParameter: () => ' b ' })
    expect(view.getProperty('/runtimeRows').map((r) => r.id)).toEqual(['b'])
    view.setProperty('/status', 'STARTED')
    ctl.onStatusFilter()
    expect(view.getProperty('/runtimeRows')).toEqual([])
    ctl.onExit()
  })

  test('Messages on a row: the logs of that iFlow, opened; clearing shows all again', async () => {
    const { open, view, ctl, api } = monitor()
    await open()
    view.setProperty('/open/logs', false)
    await ctl.onShowMessages(press(ctl, { id: 'a', name: 'A' }))
    expect(view.getProperty('/open/logs')).toBe(true)
    expect(view.getProperty('/logIflowName')).toBe('A')
    expect(logQuery(api).get('iflowId')).toBe('a')
    await ctl.onClearIflow()
    expect(logQuery(api).has('iflowId')).toBe(false)
    ctl.onExit()
  })

  test('log search is sent to the server; a later plain link clears it and the iFlow', async () => {
    const { open, view, ctl, api } = monitor()
    await open({ iflow: 'a' })
    expect(logQuery(api).get('iflowId')).toBe('a')
    await ctl.onLogSearch({ getParameter: () => ' north ' })
    expect(logQuery(api).get('search')).toBe('north')
    await open()
    expect(view.getProperty('/logIflow')).toBe('')
    expect(view.getProperty('/logSearch')).toBe('')
    expect(logQuery(api).has('search')).toBe(false)
    ctl.onExit()
  })
})

describe('runtime auto-refresh errors', () => {
  test('failing refreshes show one error in the panel, no dialogs, and keep the last list; a good one clears it', async () => {
    const { open, view, ctl, api } = monitor()
    ctl.showError = jest.fn()
    await open()
    expect(view.getProperty('/runtime')).toHaveLength(2)
    const get = api.get.getMockImplementation()
    api.get.mockImplementation(async (url) => {
      if (url.startsWith('/RuntimeArtifacts')) throw Object.assign(new Error('CPI not reachable'), { hint: 'check the destination' })
      return get(url)
    })
    for (let i = 0; i < 3; i++) await ctl.loadRuntime() // three auto-refreshes
    expect(ctl.showError).not.toHaveBeenCalled()
    expect(view.getProperty('/runtimeError')).toBe('CPI not reachable — check the destination')
    expect(view.getProperty('/runtimeRows').map((r) => r.id)).toEqual(['b', 'a'])
    expect(view.getProperty('/runtimeBusy')).toBe(false)
    api.get.mockImplementation(get)
    await ctl.loadRuntime()
    expect(view.getProperty('/runtimeError')).toBeNull()
    ctl.onExit()
  })
})
