/**
 * App shell: the side navigation highlights the page shown; on "Page not found" (a bypassed
 * route) no entry is highlighted. The controller is loaded with stubbed UI5 dependencies.
 */
const path = require('path')

function factoryOf(file) {
  let factory
  global.sap = { ui: { define: (_deps, f) => (factory = f) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return factory
}

test('a route highlights its menu entry; "Page not found" highlights none', () => {
  const handlers = {}
  const router = { attachRouteMatched: (fn) => (handlers.matched = fn), attachBypassed: (fn) => (handlers.bypassed = fn) }
  const data = { selectedKey: 'dashboard' }
  const app = { setProperty: (p, v) => (data[p.slice(1)] = v) }
  const BaseController = { extend: (_n, proto) => proto }
  const api = { get: jest.fn(async () => ({})) }
  const ctl = Object.create(factoryOf(path.join(__dirname, '../app/integration-pilot/webapp/controller/App.controller.js'))(BaseController, api))
  const sideNav = { setSelectedItem: jest.fn() }
  Object.assign(ctl, { getOwnerComponent: () => ({ getRouter: () => router }), getModel: () => app, byId: (id) => id === 'sideNav' && sideNav })
  ctl.onInit()
  try {
    handlers.matched({ getParameter: () => 'monitor' })
    expect(data.selectedKey).toBe('monitor')
    handlers.bypassed({})
    expect(data.selectedKey).toBe('')
    expect(sideNav.setSelectedItem).toHaveBeenCalledWith(null)
  } finally {
    ctl.onExit() // stops the health timer, also when an expectation fails
  }
})
