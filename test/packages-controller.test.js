/**
 * Packages page: editing keeps a formatted description, the create dialog from the Dashboard
 * loads the list once, and a package without a name does not break the list.
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

function packages(list) {
  const api = {
    get: jest.fn(async () => list.map((p) => ({ ...p }))),
    patch: jest.fn(async (_url, body) => ({ name: 'P', ...body })),
    post: jest.fn(async (_url, body) => body),
    seg: encodeURIComponent
  }
  const BaseController = { extend: (_n, proto) => proto }
  const ctl = Object.create(factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/Packages.controller.js'))(BaseController, JSONModel, null, api))
  const models = {}
  let matched
  const navTo = jest.fn((_name, _args, _replace) => matched({ getParameter: () => ({}) })) // the router fires the route again
  Object.assign(ctl, {
    setModel: (m, name) => (models[name] = m),
    getModel: (name) => models[name],
    getRouter: () => ({ getRoute: () => ({ attachPatternMatched: (fn) => (matched = fn) }), navTo }),
    toast: jest.fn(),
    openDialog(form) {
      models.view.setProperty('/form', { busy: false, error: null, ...form })
    },
    _dialog: { close: () => ctl.onDialogClosed() }
  })
  ctl.onInit()
  const open = async (query) => {
    matched({ getParameter: () => (query ? { '?query': query } : {}) })
    await new Promise((r) => setImmediate(r))
  }
  const loads = () => api.get.mock.calls.length
  return { ctl, view: models.view, api, open, loads }
}

const html = { id: 'P', name: 'P', shortText: 'P', version: '1.0.0', description: '<p>Orders <b>inbound</b></p><ul><li>EU</li></ul>' }
const edit = (ctl, p) => ctl.onEdit({ getSource: () => ({ getBindingContext: () => ({ getObject: () => p }) }) })

describe('Packages: edit keeps a formatted description', () => {
  test('only the version changed: the description is not sent (CPI keeps the HTML)', async () => {
    const s = packages([html])
    await s.open()
    edit(s.ctl, html)
    expect(s.view.getProperty('/form/description')).toBe('Orders inboundEU')
    s.view.setProperty('/form/version', '1.0.1')
    await s.ctl.onSave()
    const [, body] = s.api.patch.mock.calls[0]
    expect(body.version).toBe('1.0.1')
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('description') // as util/api.js sends it
  })

  test('an edited description is sent', async () => {
    const s = packages([html])
    await s.open()
    edit(s.ctl, html)
    s.view.setProperty('/form/description', 'Orders inbound, EU only')
    await s.ctl.onSave()
    expect(s.api.patch.mock.calls[0][1].description).toBe('Orders inbound, EU only')
  })
})

test('create from the Dashboard (?new=1): the list loads once after saving, not twice', async () => {
  const s = packages([html])
  await s.open({ new: '1' })
  expect(s.loads()).toBe(1)
  Object.assign(s.view.getProperty('/form'), { id: 'New', name: 'New', version: '1.0.0' })
  global.window = { location: { hash: '#/packages?new=1' } }
  try {
    await s.ctl.onSave()
    await new Promise((r) => setImmediate(r))
  } finally {
    delete global.window
  }
  expect(s.api.post).toHaveBeenCalled()
  expect(s.loads()).toBe(2) // opening + after saving; dropping "?new=1" does not load again
  await s.open() // a later visit loads as usual
  expect(s.loads()).toBe(3)
})

test('a package without a name does not break the list', async () => {
  const s = packages([{ id: 'B', name: 'Beta' }, { id: 'X' }, { id: 'A', name: 'Alpha' }])
  await s.open()
  expect(s.view.getProperty('/error')).toBeNull()
  expect(s.view.getProperty('/packages').map((p) => p.id)).toEqual(['X', 'A', 'B'])
})
