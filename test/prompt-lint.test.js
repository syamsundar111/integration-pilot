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
const USERS_SUMMARY = fs.readFileSync(path.join(__dirname, '../scripts/measure/users-summary-request.md'), 'utf8')
const keys = (warnings) => warnings.map((w) => w.key)

describe('prompt linter', () => {
  test('the Users Summary request only lacks package and authentication', () => {
    // {{…}} are URLs; the a.–g. lines of the script description are not steps
    expect(keys(lint(USERS_SUMMARY))).toEqual(['package', 'auth'])
    expect(estimateSteps(USERS_SUMMARY)).toBe(7)
  })

  test('session defaults silence the missing-info warnings', () => {
    expect(lint(USERS_SUMMARY, { defaults: { packageId: 'IntegrationPilot.Demo', timer: 'once', authNote: 'OAuth2 Client Credentials' } })).toEqual([])
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

  describe('follow-up messages (manual test 9)', () => {
    const first = 'Create an iFlow in package Pilot, HTTPS sender /orders, no authentication. Split the orders with a splitter and send them via SFTP, then post to https://example.org/orders.'

    test('the check runs on the whole conversation: no false "no trigger" or "no authentication"', () => {
      // alone, the follow-up looks like a build request without trigger and auth
      expect(keys(lint('Build the iFlow and post the result to https://example.org/target'))).toEqual(expect.arrayContaining(['trigger', 'auth']))
      expect(lint('Build the iFlow and post the result to https://example.org/target', { history: [first] })).toEqual([])
    })

    test('session defaults count for the whole conversation', () => {
      const request = 'Create an iFlow that posts the order to https://example.org/orders'
      expect(lint('Yes, build it', { history: [request], defaults: { packageId: 'P', timer: 'once', authNote: 'none' } })).toEqual([])
    })

    test('unsupported step names in a negation are not flagged', () => {
      expect(lint('Build an iFlow on a timer in package P, no auth: skip the splitter and the SFTP part.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P without a router, no auth.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P, no auth. Use a Groovy script instead of a message mapping.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P, no router and no SFTP, no auth.')).toEqual([])
      // a new clause ends the negation
      const w = lint('Build an iFlow on a timer in package P without a router, but add a splitter. No auth.')
      expect(w.map((x) => x.message)).toEqual([expect.stringMatching(/Not supported in v1: splitter\./)])
      expect(keys(lint('Build an iFlow on a timer in package P, no authentication, use a router.'))).toEqual(['unsupported'])
    })

    test('the reply "skip them" does not repeat the warning of the first message', () => {
      expect(keys(lint(first))).toEqual(['unsupported'])
      expect(lint('Skip the splitter and SFTP, build the rest.', { history: [first] })).toEqual([])
      expect(lint('OK, build the supported parts only.', { history: [first] })).toEqual([])
    })

    test('only warnings that are new compared with the first message are shown', () => {
      // missing package was already shown for the first message
      const noPackage = 'Create an iFlow on a timer that posts to https://example.org/x, no authentication.'
      expect(keys(lint(noPackage))).toEqual(['package'])
      expect(lint('Also add a Content Modifier that sets header Source = SF.', { history: [noPackage] })).toEqual([])
      // a step kind not named before is new; the ones already warned about are not repeated
      const w = lint('Add a multicast after step 2 and a router.', { history: [first] })
      expect(keys(w)).toEqual(['unsupported'])
      expect(w[0].message).toMatch(/Not supported in v1: router, multicast\./)
      // new {{Param}} outside a URL
      expect(keys(lint('Add header Source = {{SourceSystem}}.', { history: [first] }))).toEqual(['params'])
    })
  })

  describe('package Name instead of ID (manual test 10)', () => {
    test('a package with underscores or spaces is information, not a warning', () => {
      const w = lint('Create an iFlow in package test_1 on a timer that posts to https://example.org, no authentication.')
      expect(w).toEqual([{ key: 'packageId', level: 'info', message: 'Package ID will be test1 (CPI does not allow underscores in IDs).' }])
      expect(lint('Create an iFlow on a timer in package "My Test_Package", no auth.')).toEqual([
        { key: 'packageId', level: 'info', message: 'Package ID will be MyTestPackage (CPI does not allow underscores or spaces in IDs).' }
      ])
      expect(lint('Create an iFlow on a timer, package name: Sales_EU, no auth.').map((x) => x.message)).toEqual(['Package ID will be SalesEU (CPI does not allow underscores in IDs).'])
    })

    test('a valid ID gives nothing; a Name without letters or digits is a warning', () => {
      expect(lint('Create an iFlow in package PilotReference on a timer, no auth.')).toEqual([])
      const w = lint('Create an iFlow in package "___" on a timer, no auth.')
      expect(w).toEqual([{ key: 'packageId', message: expect.stringMatching(/no letters or digits/) }])
    })

    test('not for data values or when the session default package is set', () => {
      expect(lint('Create an iFlow on a timer in package P, no auth. Set property packagename = TEAM_EU.')).toEqual([])
      expect(lint('Create an iFlow in package test_1 on a timer, no auth.', { defaults: { packageId: 'Other' } })).toEqual([])
    })

    test('not repeated on follow-ups', () => {
      const first = 'Create an iFlow in package test_1 on a timer, no auth.'
      expect(lint('Also add a Content Modifier, package test_1.', { history: [first] })).toEqual([])
    })
  })

  test('an imported draft counts as trigger and package (manual test 15)', () => {
    const history = ['Import the iFlow from PlantMaintenanceIFlow.zip.']
    const message = 'Propose the imported iFlow as a new iFlow.'
    expect(keys(lint(message, { history }))).toEqual(['package', 'trigger']) // without the draft
    expect(lint(message, { history, draft: { trigger: true, packageId: 'Imported' } })).toEqual([])
  })
})

