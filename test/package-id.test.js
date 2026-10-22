/**
 * Package Name -> ID as in CPI (srv/lib/package-id.js), and the same logic in the browser
 * (toPackageId in app/integration-pilot/webapp/util/promptLint.js).
 */
const path = require('path')
const { toPackageId } = require('../srv/lib/package-id')

function loadUi5Module(file) {
  let exported
  global.sap = { ui: { define: (_deps, factory) => (exported = factory()) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return exported
}
const ui = loadUi5Module(path.join(__dirname, '../app/integration-pilot/webapp/util/promptLint.js'))

const CASES = [
  ['test_1', { id: 'test1', name: 'test_1', note: 'Package ID will be test1 (CPI does not allow underscores in IDs).' }],
  ['My Test_Package', { id: 'MyTestPackage', name: 'My Test_Package', note: 'Package ID will be MyTestPackage (CPI does not allow underscores or spaces in IDs).' }],
  ['Sales Orders', { id: 'SalesOrders', name: 'Sales Orders', note: 'Package ID will be SalesOrders (CPI does not allow spaces in IDs).' }],
  ['TEAM_A-EU (new)', { id: 'TEAMAEUnew', name: 'TEAM_A-EU (new)', note: 'Package ID will be TEAMAEUnew (CPI does not allow underscores, spaces or special characters in IDs).' }],
  ['com.sap.Demo', { id: 'com.sap.Demo', name: null, note: null }],
  ['  PilotReference ', { id: 'PilotReference', name: null, note: null }],
  ['___', { id: '', name: '___', note: null }],
  ['', { id: '', name: null, note: null }]
]

describe('package Name -> ID', () => {
  test.each(CASES)('%j', (value, expected) => {
    expect(toPackageId(value)).toEqual(expected)
  })

  test('the browser derives the same IDs and notes', () => {
    for (const [value] of CASES) expect(ui.toPackageId(value)).toEqual(toPackageId(value))
  })
})
