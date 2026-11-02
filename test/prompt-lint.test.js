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
  test('the Users Summary request passes: {{…}} are URLs, the a.–g. lines of the script description are not steps', () => {
    expect(lint(USERS_SUMMARY)).toEqual([])
    expect(estimateSteps(USERS_SUMMARY)).toBe(7)
  })

  test('a missing trigger, package or authentication is no warning: the assistant uses defaults', () => {
    expect(lint('Create an iFlow that posts the order to https://example.org/orders')).toEqual([])
  })

  test('multicast and join are supported (phase 9); Content Enricher and Poll Enrich are not yet', () => {
    expect(lint('Create an iFlow on a timer, package P, no auth: a router; both routes join again at CM_Join.')).toEqual([])
    expect(lint('Create an iFlow on a timer, package P, no auth: a multicast, then a join step and a gather.')).toEqual([])
    expect(lint('Create an iFlow on a timer, package P, no auth: a content enricher, then a poll enrich.')[0].message).toMatch(/Not supported yet: content enricher, poll enrich\./)
  })

  test('unsupported step kinds, ignoring quoted text', () => {
    const w = lint('Build an iFlow on a timer in package P: use a router, then a General Splitter, an XSLT, a message mapping and an SFTP receiver, a Write Variables step and a Process Call. No auth.')
    expect(keys(w)).toEqual(['unsupported'])
    expect(w[0].message).toMatch(/Not supported yet: SFTP\./) // Write Variables (1a), routers (1b), splitters and process calls (2), mappings (4) are supported
    expect(lint('Build an iFlow on a timer in package P that sets property Kind = "router mapping". No auth.')).toEqual([])
    expect(keys(lint('Add a content enricher after step 2'))).toEqual(['unsupported'])
  })

  test('a mail server, credential and recipients can be parameters (phase 3); a subject cannot', () => {
    const start = 'Build an iFlow on a timer in package P, no authentication.'
    expect(lint(`${start}\nSend a mail: server externalized as {{Mail_Server}}, credential externalized as {{Mail_Cred}}, to externalized as {{Mail_To}}.`)).toEqual([])
    expect(lint(`${start}\nSend a mail: server {{Mail_Server}}, mail to {{Mail_To}}.`)).toEqual([])
    expect(keys(lint(`${start}\nSend a mail with subject {{Subject}}.`))).toEqual(['params'])
  })

  test('more than 50 steps', () => {
    const many = ['Create an iFlow on a timer in package P. No auth.', ...Array.from({ length: 52 }, (_, i) => `${i + 1}. Content Modifier "Step ${i + 1}"`)].join('\n')
    expect(keys(lint(many))).toEqual(['steps'])
  })

  test('a password, secret or token is flagged; a credential name is not', () => {
    const keys = (t) => lint(t).map((w) => w.key)
    expect(keys('Create an iFlow that calls https://erp.example.com/api with Basic, credential ERP_BASIC_USER, On-Premise location ERP_LOC')).toEqual([])
    for (const t of [
      'Create an iFlow calling the ERP with user admin password: Welcome1',
      'Create an iFlow with OAuth2, client secret = abc123XYZ987',
      'Create an iFlow calling https://admin:pw123@erp.example.com/api',
      'Create an iFlow, header Authorization = Bearer eyJhbGciOiJIUzI1NiJ9.abc'
    ])
      expect(keys(t)).toEqual(['secret'])
    expect(lint('password: x1').map((w) => w.message)).toEqual([expect.stringMatching(/^This looks like a password, secret or token\. Never send credentials/)])
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
    expect(keys(lint(`${request}\n5. Add a content enricher after step 4. Set header X = {{Other}}.`))).toEqual(['unsupported', 'params'])
  })

  describe('follow-up messages (manual test 9)', () => {
    const first = 'Create an iFlow in package Pilot, HTTPS sender /orders, no authentication. Split the orders with a splitter and send them via SFTP, then post to https://example.org/orders.'

    test('the check runs on the whole conversation: a step kind warned about before is not repeated', () => {
      expect(keys(lint('Build it with an SFTP receiver.'))).toEqual(['unsupported'])
      expect(lint('Build it with an SFTP receiver.', { history: [first] })).toEqual([])
    })

    test('unsupported step names in a negation are not flagged', () => {
      expect(lint('Build an iFlow on a timer in package P, no auth: skip the splitter and the SFTP part.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P without a router, no auth.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P, no auth. Use a Groovy script instead of a message mapping.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P, no router and no SFTP, no auth.')).toEqual([])
      // a new clause ends the negation
      const w = lint('Build an iFlow on a timer in package P without a router, but add a content enricher. No auth.')
      expect(w.map((x) => x.message)).toEqual([expect.stringMatching(/Not supported yet: content enricher\./)])
      expect(keys(lint('Build an iFlow on a timer in package P, no authentication, use a content enricher.'))).toEqual(['unsupported'])
      // routers (phase 1b), splitters, gathers and process calls (phase 2) are supported
      expect(lint('Build an iFlow on a timer in package P, no authentication, use a router.')).toEqual([])
      expect(lint('Build an iFlow on a timer in package P, no authentication: a General Splitter, a Process Call to a local process, then a Gather.')).toEqual([])
    })

    test('an SFTP sender is supported; SFTP as a receiver is not; its five fields may be parameters', () => {
      expect(lint('Create an iFlow in package P with an SFTP sender, no auth.')).toEqual([])
      expect(lint('Create an iFlow in package P that polls files from an SFTP server every 15 minutes, no auth.')).toEqual([])
      // the chat prompt of the phase 5 tenant check: SFTP in the iFlow name and an SFTP server as the source
      expect(lint('Create iFlow Builder V2 Phase5 SFTP Chat in package iglow. It picks up order files from an SFTP server: directory /dummy/in, file name *.xml, authentication user name and password with the credential DUMMY_SFTP_CREDENTIAL. For each file, set the property fileName from the header CamelFileName. If something fails, store the error message in a property.')).toEqual([])
      expect(lint('Build an iFlow in package P with SFTP, no auth.')).toEqual([])
      for (const text of ['write the files to SFTP', 'send them via SFTP', 'store the result on the SFTP server', 'an sftp-receiver'])
        expect(keys(lint(`Create an iFlow in package P and ${text}, no auth.`))).toEqual(['unsupported'])
      expect(keys(lint('Create an iFlow in package P with an SFTP receiver, no auth.'))).toEqual(['unsupported'])
      expect(keys(lint('Create an iFlow in package P and upload the result to SFTP, no auth.'))).toEqual(['unsupported'])
      expect(lint('Create an iFlow in package P with an SFTP sender: host {{SFTP_Address}}, directory {{SFTP_Directory}}, file name {{SFTP_FileName}}, credential {{SFTP_Credential}}, archive directory {{SFTP_Archive}}, no auth.')).toEqual([])
      expect(keys(lint('Create an iFlow in package P with an SFTP sender, user name {{SFTP_User}}, no auth.'))).toEqual(['params'])
    })

    test('the reply "skip them" does not repeat the warning of the first message', () => {
      expect(keys(lint(first))).toEqual(['unsupported'])
      expect(lint('Skip the splitter and SFTP, build the rest.', { history: [first] })).toEqual([])
      expect(lint('OK, build the supported parts only.', { history: [first] })).toEqual([])
    })

    test('only warnings that are new compared with the first message are shown', () => {
      expect(lint('Also add a Content Modifier that sets header Source = SF.', { history: [first] })).toEqual([])
      // a step kind not named before is new; the ones already warned about are not repeated
      const w = lint('Add a content enricher after step 2 and a mapping step.', { history: [first] })
      expect(keys(w)).toEqual(['unsupported'])
      expect(w[0].message).toMatch(/Not supported yet: content enricher\./)
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

    test('not for data values', () => {
      expect(lint('Create an iFlow on a timer in package P, no auth. Set property packagename = TEAM_EU.')).toEqual([])
    })

    test('not repeated on follow-ups', () => {
      const first = 'Create an iFlow in package test_1 on a timer, no auth.'
      expect(lint('Also add a Content Modifier, package test_1.', { history: [first] })).toEqual([])
    })
  })

  test('proposing an imported iFlow gives no warning (manual test 15)', () => {
    expect(lint('Propose the imported iFlow as a new iFlow.', { history: ['Import the iFlow from PlantMaintenanceIFlow.zip.'] })).toEqual([])
  })

})

