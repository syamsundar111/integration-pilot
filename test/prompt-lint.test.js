/**
 * Client-side prompt linter (app/integration-pilot/webapp/util/promptLint.js), loaded through
 * a minimal sap.ui.define stub.
 */
const fs = require('fs')
const path = require('path')

function loadUi5Module(file) {
  let exported
  global.sap = { ui: { define: (_deps, factory) => (exported = factory()) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return exported
}

const { lint, estimateSteps, TEMPLATE } = loadUi5Module(path.join(__dirname, '../app/integration-pilot/webapp/util/promptLint.js'))
const SF_ENTRA = fs.readFileSync(path.join(__dirname, '../scripts/measure/sf-entra-request.md'), 'utf8')
const keys = (warnings) => warnings.map((w) => w.key)

describe('prompt linter', () => {
  test('the SF -> Directory request only lacks package and authentication', () => {
    // "contains \"mapping\"", "Join to each user" and "value-mapped" are not steps; {{…}} are URLs
    expect(keys(lint(SF_ENTRA))).toEqual(['package', 'auth'])
    expect(estimateSteps(SF_ENTRA)).toBe(6)
  })

  test('session defaults silence the missing-info warnings', () => {
    expect(lint(SF_ENTRA, { defaults: { packageId: 'DEV.SF', timer: 'once', authNote: 'OAuth2 SAML Bearer' } })).toEqual([])
  })

  test('missing trigger, package and auth on a build request', () => {
    expect(keys(lint('Create an iFlow that posts the order to https://example.org/orders'))).toEqual(['package', 'trigger', 'auth'])
    expect(keys(lint('Create an iFlow, timer run once, package Pilot, that posts to https://example.org with no authentication'))).toEqual([])
  })

  test('unsupported step kinds, ignoring quoted text', () => {
    const w = lint('Build an iFlow on a timer in package P: use a router, then a General Splitter, an XSLT, a message mapping and an SFTP receiver, a Write Variables step and a Process Call. No auth.')
    expect(keys(w)).toEqual(['unsupported'])
    expect(w[0].message).toMatch(/router, splitter, XSLT, mapping, SFTP, write variables, process call/)
    expect(w[0].message).toMatch(/Attach the .xsl file/)
    expect(lint('Build an iFlow on a timer in package P that sets property Kind = "router mapping". No auth.')).toEqual([])
    expect(keys(lint('Add a multicast after step 2, then gather and join the branches'))).toEqual(['unsupported'])
  })

  test('more than 25 steps', () => {
    const many = ['Create an iFlow on a timer in package P. No auth.', ...Array.from({ length: 27 }, (_, i) => `${i + 1}. Content Modifier "Step ${i + 1}"`)].join('\n')
    expect(keys(lint(many))).toEqual(['steps'])
  })

  test('{{Param}} outside a URL', () => {
    const w = lint('Create an iFlow on a timer in package P. Set header Source = {{SourceSystem}}. No auth.')
    expect(keys(w)).toEqual(['params'])
    expect(w[0].message).toContain('{{SourceSystem}}')
  })

  test('the unfilled template is flagged; questions are not linted', () => {
    expect(keys(lint(TEMPLATE))).toContain('template')
    expect(lint('Which iFlows are in error right now, and why?')).toEqual([])
    expect(lint('Explain the mapping in iFlow Pilot_Test_1.')).toEqual([])
  })
})
