/**
 * iFlows detail: answers that arrive after another iFlow was opened are dropped (bug: open A, then B
 * quickly; A's late parameters showed under B, and "Save parameters" would have written them to B).
 * The controller is loaded with stubbed UI5 dependencies, as in monitor-controller.test.js.
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

/** A server whose answers are released by the test, in any order */
function slowServer() {
  const pending = []
  const answers = {
    'A/configurations': [{ key: 'KeyOfA', value: 'a' }],
    'B/configurations': [{ key: 'KeyOfB', value: 'b' }],
    'A/runtime': { id: 'A', status: 'STARTED' },
    'B/runtime': { id: 'B', status: 'ERROR' },
    B: { message: 'error of B' }
  }
  const get = jest.fn((url) => {
    const [, iflow, what] = url.match(/^\/(?:Iflows|RuntimeArtifacts)\/([^/]+)\/(\w+)/) || []
    const key = what === 'errorInfo' ? iflow : `${iflow}/${what}`
    return new Promise((resolve, reject) => pending.push({ key, resolve: () => resolve(answers[key] ?? []), reject: () => reject(new Error(`${key} failed`)) }))
  })
  const settle = async (prefix, how = 'resolve') => {
    for (const p of pending.filter((x) => x.key.startsWith(prefix))) {
      pending.splice(pending.indexOf(p), 1)
      p[how]()
    }
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  return { api: { get, seg: encodeURIComponent, q: () => '' }, settle }
}

function iflows() {
  const server = slowServer()
  const BaseController = { extend: (_n, proto) => proto }
  const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }
  const proto = factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Iflows.controller.js'))(BaseController, JSONModel, server.api, flowDiagram)
  const ctl = Object.create(proto)
  const models = {}
  Object.assign(ctl, {
    setModel: (m, name) => (models[name] = m),
    getModel: (name) => models[name],
    getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }) })
  })
  ctl.onInit()
  return { ctl, view: models.view, settle: server.settle }
}

describe('iFlow detail ignores late answers for a previously opened iFlow', () => {
  test('open A, then B; A answers last: parameters and runtime stay those of B', async () => {
    const { ctl, view, settle } = iflows()
    ctl.openDetail('A')
    ctl.openDetail('B')
    await settle('B')
    await settle('B') // B is in ERROR: its error details
    await settle('A')
    expect(view.getProperty('/iflowId')).toBe('B')
    expect(view.getProperty('/configs').map((c) => c.key)).toEqual(['KeyOfB'])
    expect(view.getProperty('/original')).toEqual({ KeyOfB: 'b' })
    expect(view.getProperty('/runtime')).toMatchObject({ id: 'B', status: 'ERROR' })
    expect(view.getProperty('/runtimeError')).toBe('error of B')
  })

  test('A answers while B is still loading: B stays busy and A is not shown', async () => {
    const { ctl, view, settle } = iflows()
    ctl.openDetail('A')
    ctl.openDetail('B')
    await settle('A')
    expect(view.getProperty('/configs')).toEqual([])
    expect(view.getProperty('/runtime')).toBeNull()
    expect(view.getProperty('/configsBusy')).toBe(true)
    expect(view.getProperty('/runtimeBusy')).toBe(true)
    await settle('B')
    expect(view.getProperty('/configs').map((c) => c.key)).toEqual(['KeyOfB'])
    expect(view.getProperty('/configsBusy')).toBe(false)
  })

  test("A's late failure does not clear B's data", async () => {
    const { ctl, view, settle } = iflows()
    ctl.openDetail('A')
    ctl.openDetail('B')
    await settle('B')
    await settle('B')
    await settle('A', 'reject')
    expect(view.getProperty('/configs').map((c) => c.key)).toEqual(['KeyOfB'])
    expect(view.getProperty('/runtime')).toMatchObject({ id: 'B' })
    expect(view.getProperty('/parsedError')).toBeNull()
  })
})

describe('unsaved parameter changes are not dropped without asking', () => {
  /** Dialog stub: the test answers with the button text */
  function dialogs() {
    const opened = []
    function Dialog(o) {
      this.o = o
      this.open = () => opened.push(this)
      this.close = () => o.afterClose()
      this.destroy = () => {}
      this.answer = (text) => [o.beginButton, o.endButton].find((b) => b.o.text === text).o.press()
    }
    function Button(o) {
      this.o = o
    }
    function Text(o) {
      this.o = o
    }
    return { Dialog, Button, Text, opened }
  }

  function setup() {
    const d = dialogs()
    const api = { get: jest.fn(async (url) => (url.endsWith('/configurations') ? [{ key: 'URL', value: 'old' }] : url === '/Packages' ? [{ id: 'P', name: 'P' }] : [])), seg: encodeURIComponent, q: () => '' }
    const BaseController = { extend: (_n, proto) => proto }
    const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }
    const proto = factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Iflows.controller.js'))(BaseController, JSONModel, api, flowDiagram, null, d.Dialog, d.Button, null, d.Text)
    const ctl = Object.create(proto)
    const models = {}
    const navTo = jest.fn()
    Object.assign(ctl, {
      setModel: (m, name) => (models[name] = m),
      getModel: (name) => models[name],
      getView: () => ({ addDependent: () => {} }),
      getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }), navTo })
    })
    ctl.onInit()
    const view = models.view
    view.setProperty('/iflows', [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }])
    view.setProperty('/packageId', 'P') // the list of package P is shown
    ctl._listPackageId = 'P'
    const route = (query) => ctl.onRoute({ getParameter: () => ({ '?query': query }) })
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    }
    return { ctl, view, route, navTo, opened: d.opened, flush }
  }

  async function editing(s) {
    await s.route({ package: 'P', iflow: 'A' })
    await s.flush()
    s.view.setProperty('/configs/0/value', 'new')
    s.ctl.onParamChange()
    expect(s.view.getProperty('/changes')).toBe(1)
  }

  test('opening another iFlow asks; "Keep editing" stays on A with the edit', async () => {
    const s = setup()
    await editing(s)
    const leaving = s.route({ package: 'P', iflow: 'B' })
    await s.flush()
    expect(s.opened).toHaveLength(1)
    s.opened[0].answer('Keep editing')
    await leaving
    expect(s.view.getProperty('/iflowId')).toBe('A')
    expect(s.view.getProperty('/configs/0/value')).toBe('new')
    expect(s.navTo).toHaveBeenLastCalledWith('iflows', { '?query': { package: 'P', iflow: 'A' } }, true) // the URL goes back to A
  })

  test('"Discard changes" opens B', async () => {
    const s = setup()
    await editing(s)
    const leaving = s.route({ package: 'P', iflow: 'B' })
    await s.flush()
    s.opened[0].answer('Discard changes')
    await leaving
    await s.flush()
    expect(s.view.getProperty('/iflowId')).toBe('B')
    expect(s.view.getProperty('/changes')).toBe(0)
  })

  test('closing the detail, another package or coming back from another page also ask', async () => {
    for (const query of [{ package: 'P' }, { package: 'Q' }, {}]) {
      const s = setup()
      await editing(s)
      const leaving = s.route(query)
      await s.flush()
      expect(s.opened).toHaveLength(1)
      s.opened[0].answer('Keep editing')
      await leaving
      expect(s.view.getProperty('/iflowId')).toBe('A')
    }
  })

  test('without unsaved changes nothing is asked', async () => {
    const s = setup()
    await s.route({ package: 'P', iflow: 'A' })
    await s.flush()
    await s.route({ package: 'P', iflow: 'B' })
    expect(s.opened).toHaveLength(0)
    expect(s.view.getProperty('/iflowId')).toBe('B')
  })
})

describe('the package list follows new packages', () => {
  function setup(packages) {
    const api = {
      get: jest.fn(async (url) => (url === '/Packages' ? packages.slice() : [])),
      seg: encodeURIComponent,
      q: () => ''
    }
    const BaseController = { extend: (_n, proto) => proto }
    const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }
    const proto = factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Iflows.controller.js'))(BaseController, JSONModel, api, flowDiagram)
    const ctl = Object.create(proto)
    const models = {}
    const navTo = jest.fn()
    Object.assign(ctl, {
      setModel: (m, name) => (models[name] = m),
      getModel: (name) => models[name],
      getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }), navTo })
    })
    ctl.onInit()
    const route = (query) => ctl.onRoute({ getParameter: () => ({ '?query': query }) })
    const packageLoads = () => api.get.mock.calls.filter(([u]) => u === '/Packages').length
    return { ctl, view: models.view, route, navTo, packageLoads }
  }

  test('a link to a package created since the page was opened loads the packages again', async () => {
    const packages = [{ id: 'P', name: 'P' }]
    const s = setup(packages)
    await s.route({ package: 'P' })
    packages.push({ id: 'New', name: 'New' }) // e.g. created by an approved proposal
    await s.route({ package: 'New', iflow: 'X' })
    expect(s.packageLoads()).toBe(2)
    expect(s.view.getProperty('/packages').map((p) => p.id)).toEqual(['P', 'New'])
    expect(s.view.getProperty('/packageId')).toBe('New')
    expect(s.navTo).not.toHaveBeenCalled()
  })

  test('a known package does not reload the list', async () => {
    const s = setup([{ id: 'P', name: 'P' }, { id: 'Q', name: 'Q' }])
    await s.route({ package: 'P' })
    await s.route({ package: 'Q' })
    expect(s.packageLoads()).toBe(1)
  })

  test('a package that no longer exists falls back to the first package', async () => {
    const s = setup([{ id: 'B', name: 'Beta' }, { id: 'A', name: 'Alpha' }])
    await s.route({ package: 'Gone' })
    expect(s.navTo).toHaveBeenCalledWith('iflows', { '?query': { package: 'A' } }, true)
  })

  test('Refresh reloads the packages', async () => {
    const s = setup([{ id: 'P', name: 'P' }])
    await s.route({ package: 'P' })
    s.ctl.onRefresh()
    expect(s.packageLoads()).toBe(2)
  })
})

describe('Deploy / Undeploy run once at a time', () => {
  function setup() {
    let release
    const api = { get: jest.fn(async () => []), post: jest.fn(() => new Promise((resolve, reject) => (release = { resolve, reject }))), seg: encodeURIComponent, q: () => '' }
    const BaseController = { extend: (_n, proto) => proto }
    const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }
    const ctl = Object.create(factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Iflows.controller.js'))(BaseController, JSONModel, api, flowDiagram))
    const models = {}
    Object.assign(ctl, {
      setModel: (m, name) => (models[name] = m),
      getModel: (name) => models[name],
      getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }) }),
      confirm: jest.fn(async () => true),
      toast: jest.fn(),
      showError: jest.fn(),
      afterRuntimeChange: jest.fn()
    })
    ctl.onInit()
    models.view.setProperty('/iflowId', 'A')
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    }
    return { ctl, view: models.view, api, release: () => release, flush }
  }

  test('while a deploy runs, Deploy and Undeploy wait: no second confirm, no second request', async () => {
    const s = setup()
    const first = s.ctl.onDeploy()
    await s.flush()
    expect(s.view.getProperty('/writing')).toBe('deploy')
    await s.ctl.onDeploy()
    await s.ctl.onUndeploy()
    expect(s.ctl.confirm).toHaveBeenCalledTimes(1)
    expect(s.api.post).toHaveBeenCalledTimes(1)
    s.release().resolve({})
    await first
    expect(s.view.getProperty('/writing')).toBeNull()
  })

  test('a failed deploy enables the buttons again', async () => {
    const s = setup()
    const first = s.ctl.onUndeploy()
    await s.flush()
    expect(s.view.getProperty('/writing')).toBe('undeploy')
    s.release().reject(new Error('deployment already in progress'))
    await first
    expect(s.ctl.showError).toHaveBeenCalled()
    expect(s.view.getProperty('/writing')).toBeNull()
  })
})

describe('Explain from ZIP', () => {
  function setup(readOk) {
    const ExplainDialog = { open: jest.fn() }
    const BaseController = { extend: (_n, proto) => proto }
    const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }
    const ctl = Object.create(factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Iflows.controller.js'))(BaseController, JSONModel, {}, flowDiagram, ExplainDialog))
    Object.assign(ctl, { getView: () => ({}), showError: jest.fn() })
    const readers = []
    global.FileReader = function () {
      readers.push(this)
      this.readAsDataURL = () => {}
      this.finish = () => (readOk ? ((this.result = 'data:application/zip;base64,UEsDBA=='), this.onload()) : this.onerror())
    }
    const uploader = { clear: jest.fn() }
    const event = { getParameter: () => [{ name: 'flow.zip', size: 100 }], getSource: () => uploader }
    const select = () => ctl.onZipSelected(event)
    return { ctl, ExplainDialog, uploader, readers, select }
  }
  afterEach(() => delete global.FileReader)

  test('after reading, the dialog opens and the uploader is cleared', () => {
    const s = setup(true)
    s.select()
    s.readers[0].finish()
    expect(s.ExplainDialog.open).toHaveBeenCalledWith({}, { zipBase64: 'UEsDBA==', label: 'flow.zip' })
    expect(s.uploader.clear).toHaveBeenCalled()
  })

  test('a read error shows the message and clears the uploader (the same file can be chosen again)', () => {
    const s = setup(false)
    s.select()
    s.readers[0].finish()
    expect(s.ctl.showError).toHaveBeenCalledWith({ message: 'The file could not be read.' })
    expect(s.uploader.clear).toHaveBeenCalled()
  })
})

describe('deleting an iFlow with unsaved parameter changes', () => {
  test('closes the detail without asking to discard them', async () => {
    const opened = []
    function Dialog(o) {
      this.open = () => opened.push(o)
    }
    const api = { get: jest.fn(async () => []), del: jest.fn(async () => ({})), seg: encodeURIComponent, q: () => '' }
    const BaseController = { extend: (_n, proto) => proto }
    const flowDiagram = { toHtml: () => '', fromParsed: () => ({}) }
    const ctl = Object.create(factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Iflows.controller.js'))(BaseController, JSONModel, api, flowDiagram, null, Dialog))
    const models = {}
    const navTo = jest.fn()
    Object.assign(ctl, {
      setModel: (m, name) => (models[name] = m),
      getModel: (name) => models[name],
      getView: () => ({ addDependent: () => {} }),
      getRouter: () => ({ getRoute: () => ({ attachPatternMatched: () => {} }), navTo }),
      toast: jest.fn(),
      typeToConfirm: jest.fn(async (o) => (await o.run(), true))
    })
    ctl.onInit()
    const view = models.view
    Object.assign(view.data, { packageId: 'P', iflowId: 'A', iflows: [{ id: 'A', name: 'A' }], configs: [{ key: 'URL', value: 'edited' }], original: { URL: 'old' }, changes: 1 })
    ctl._listPackageId = 'P'
    await ctl.onDelete()
    expect(api.del).toHaveBeenCalled()
    expect(navTo).toHaveBeenCalledWith('iflows', { '?query': { package: 'P' } }, undefined)
    await ctl.onRoute({ getParameter: () => ({ '?query': { package: 'P' } }) }) // the route the navigation fires
    expect(opened).toEqual([]) // no "Unsaved parameter changes" dialog
    expect(view.getProperty('/iflowId')).toBeNull()
  })
})
