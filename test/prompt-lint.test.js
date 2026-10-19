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

  test('more than 50 steps', () => {
    const many = ['Create an iFlow on a timer in package P. No auth.', ...Array.from({ length: 52 }, (_, i) => `${i + 1}. Content Modifier "Step ${i + 1}"`)].join('\n')
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

  test('placeholder descriptions spanning lines and {{…}} inside quotes are not flagged', () => {
    const request = [
      'Create an iFlow on a timer, run once (description: "Manual: schedule {{Scheduler}}, every 2 minutes"), package P, all receivers no authentication.',
      '1. contentModifier "CM_Set". Properties (constant): A = x.',
      '2. PH "PH_Router3": "REPLACE WITH Router \'Router 3\': Route 1 continues;',
      '   Route 2 (default) -> Write Variables WV_LastRunTime -> End 6."',
      '3. PH "PH_Split": "REPLACE WITH General Splitter \'GSPL\': XPath /root/result,',
      '   parallel off, then a Message Mapping and a Process Call."',
      '4. requestReplyHttp "RR", GET, url {{Target_URL}}, default https://example.org/x'
    ].join('\n')
    expect(lint(request)).toEqual([])
    // outside quotes they are still found
    expect(keys(lint(`${request}\n5. Add a router after step 4. Set header X = {{Other}}.`))).toEqual(['unsupported', 'params'])
  })
})
