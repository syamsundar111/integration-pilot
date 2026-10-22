/**
 * srv/agent/system-prompt.md: rules for unsupported steps (from manual test 9). Each rule is in the
 * prompt, and what it tells the model to build validates and builds.
 */
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const { validate } = require('../srv/iflow-builder/validator')
const { build } = require('../srv/iflow-builder/builder')
const sample = require('../srv/iflow-builder/samples/Pilot_Test_1.json')

const PROMPT = fs.readFileSync(path.join(__dirname, '../srv/agent/system-prompt.md'), 'utf8')
const flat = PROMPT.replace(/\s+/g, ' ')

const routingSpec = {
  ...sample,
  id: 'Prompt_Routing',
  name: 'Prompt_Routing',
  steps: [
    { type: 'groovyScript', name: 'Set Target Host', fileName: 'setTargetHost' },
    { type: 'requestReplyHttp', name: 'Call Target', url: 'https://${property.TargetHost}/orders', method: 'POST', authType: 'None', system: 'Target' }
  ]
}
const SCRIPT = `import com.sap.gateway.ip.core.customdev.util.Message
def Message processData(Message message) {
  message.setProperty('TargetHost', 'eu.example.org')
  return message
}`

describe('system prompt: unsupported steps', () => {
  test('never suggests HTTP calls from Groovy', () => {
    expect(flat).toMatch(/Never suggest HTTP calls from Groovy/)
    expect(flat).toMatch(/Every call to another system is a `requestReplyHttp` step or the `httpReceiver` end/)
    expect(flat).not.toMatch(/separate flow per branch/)
  })

  test('routing: a Groovy script sets a property and the receiver address uses ${property.<Name>}', async () => {
    expect(flat).toMatch(/Routing.*Groovy script that sets a property.*HTTP receiver whose address uses it.*\$\{property\.TargetHost\}/)
    // the address the prompt recommends is valid and ends up in the iFlow unchanged
    expect(validate(routingSpec, { attachments: ['setTargetHost.groovy'] })).toMatchObject({ valid: true })
    const { zipBase64 } = await build(routingSpec, { attachments: { 'setTargetHost.groovy': SCRIPT } })
    const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
    const iflw = await zip.file(/\.iflw$/)[0].async('string')
    expect(iflw).toContain('https://${property.TargetHost}/orders')
    // a whole ${property.X} is not a valid url in v1: the prompt says the address starts with http(s)://
    expect(flat).toMatch(/must still start with `http:\/\/` or `https:\/\/`/)
    const whole = { ...routingSpec, steps: [routingSpec.steps[0], { ...routingSpec.steps[1], url: '${property.TargetURL}' }] }
    expect(validate(whole, { attachments: ['setTargetHost.groovy'] }).valid).toBe(false)
  })

  test('does not claim Groovy can split a message', () => {
    expect(flat).toMatch(/Groovy cannot split one message into many; it can only reshape the payload/)
    expect(flat).toMatch(/Never claim that a script splits a message/)
  })

  test('offers placeholder Content Modifiers PH_<StepName> for unsupported steps', () => {
    expect(flat).toMatch(/offer to build the supported parts/)
    expect(flat).toMatch(/name it `PH_<StepName>`/)
    expect(flat).toMatch(/start its description with `REPLACE WITH`, followed by what to add manually in the CPI web editor/)
    // the placeholder as the prompt describes it is a valid step, counted as a placeholder like imported ones
    const ph = {
      type: 'contentModifier',
      name: 'PH_Splitter',
      description: "REPLACE WITH General Splitter 'Split Orders': XPath /orders/order",
      properties: [{ name: 'REPLACE_WITH', type: 'constant', value: "General Splitter 'Split Orders'" }]
    }
    const spec = { ...sample, id: 'Prompt_Placeholder', name: 'Prompt_Placeholder', steps: [sample.steps[0], ph] }
    expect(validate(spec)).toMatchObject({ valid: true })
    expect(spec.steps.filter((s) => /^REPLACE WITH /.test(s.description || ''))).toHaveLength(1)
  })
})

describe('system prompt: calling another iFlow (manual test 16)', () => {
  // the details are in the processDirect pattern; the prompt keeps a pointer
  const flat = fs.readFileSync(path.join(__dirname, '../srv/agent/patterns/processDirect.md'), 'utf8').replace(/\s+/g, ' ')
  const SENDER = fs.readFileSync(path.join(__dirname, '../srv/iflow-builder/templates/iflw/messageflow-https-sender.xml'), 'utf8')
  const value = (key) => SENDER.match(new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`))?.[1]

  test('the HTTPS sender is a workaround for ProcessDirect, not an equivalent', () => {
    expect(flat).toMatch(/v1 has no ProcessDirect sender or receiver/)
    expect(flat).toMatch(/offer this \*\*workaround\*\* \(never call it an equivalent\)/)
    expect(flat).toMatch(/ProcessDirect stays inside the tenant and needs no authentication; an HTTPS endpoint is public and every call to it must be authenticated/)
  })

  test('authentication is required: OAuth2 Client Credentials from a Process Integration Runtime service key (integration-flow)', () => {
    expect(flat).toMatch(/\*\*Authentication is required\*\*, not optional/)
    expect(flat).toMatch(/\*\*OAuth2 Client Credentials\*\*.*\*\*Process Integration Runtime\*\* instance with plan \*\*integration-flow\*\*/)
    expect(flat).toMatch(/Never write "if the target requires it"/)
    // the role the prompt names is the one the template requires
    expect(value('senderAuthType')).toBe('RoleBased')
    expect(value('userRole')).toBe('ESBMessaging.send')
  })

  test('the URL uses the -rt runtime host and a parameter named after the target', () => {
    expect(flat).toMatch(/\*\*runtime host\*\* \(the host name contains `-rt`\), path `\/http\/<address>`/)
    expect(flat).toMatch(/Monitor → Integrations and APIs → Manage Integration Content/)
    expect(flat).toMatch(/named after the target iFlow, e\.g\. `\{\{CommonNotifyURL\}\}`, never `ProcessDirectURL`/)
  })

  test('CSRF: the prompt states what the HTTPS sender template sets', () => {
    expect(value('xsrfProtection')).toBe('0') // CSRF Protected off
    expect(flat).toMatch(/create the HTTPS sender with \*CSRF Protected\* off, so the caller needs no CSRF token/)
    expect(flat).toMatch(/a caller without a token gets HTTP 403/)
  })
})

describe('system prompt: CPI script API imports (Test 16)', () => {
  test('messageLogFactory is a binding variable, never imported', () => {
    expect(flat).toMatch(/Message log: \*\*no import\*\*\. `messageLogFactory` is a binding variable, like `message`/)
    expect(flat).toMatch(/Never import a `MessageLogFactory`, and never call a static `MessageLogFactory\.getMessageLog\(\)`/)
    expect(flat).not.toMatch(/import com\.sap\.gateway\.ip\.core\.customdev\.util\.MessageLogFactory/)
  })

  test('the correct imports of the common CPI APIs are listed', () => {
    for (const i of ['com.sap.gateway.ip.core.customdev.util.Message', 'com.sap.it.api.ITApiFactory', 'com.sap.it.api.mapping.ValueMappingApi', 'com.sap.it.api.securestore.SecureStoreService'])
      expect(flat).toContain(`import ${i}`)
  })
})

describe('system prompt: types (review item 3)', () => {
  test('constant for plain values, expression only with ${...}', () => {
    expect(flat).toMatch(/`constant` for a plain value, `expression` only when the value contains `\$\{\.\.\.\}`/)
  })
})

describe('system prompt: review items 1, 2, 4 and 5', () => {
  test('1: sensible defaults, questions only about real decisions, trivial fixes applied', () => {
    expect(flat).not.toMatch(/ask concise questions about what is missing/)
    expect(flat).toMatch(/\*\*Assume sensible defaults; ask only about real decisions\.\*\*/)
    for (const d of ['end: `none`', 'no exception subprocess unless the user asks', 'JSON in and out unless the user says otherwise', 'none needed when the user says "no authentication"'])
      expect(flat).toContain(d)
    expect(flat).toMatch(/the \*\*trigger\*\*, if neither the message nor the session defaults give it/)
    expect(flat).toMatch(/the \*\*target package\*\*, if neither the message nor the session defaults give it/)
    expect(flat).toMatch(/\*\*values only the user can know\*\*: real URLs, field rules/)
    expect(flat).toMatch(/Apply trivial fixes yourself and say so in one line, without asking: duplicate step names .*package ID characters/)
  })

  test('2: user code is used verbatim; check errors are reported with file:line:column and the quoted line', () => {
    expect(flat).toMatch(/\*\*User code is the user's code\.\*\* Code the user gives in the message or attaches is used verbatim/)
    expect(flat).toMatch(/do not fix it on your own: report each error as file:line:column, quote that line, and ask whether you may fix it/)
    expect(flat).toMatch(/"Fix your own scripts" applies only to scripts you wrote/)
  })

  test('4: a placeholder default must be set before deploying; approve without deploy', () => {
    expect(flat).toMatch(/the parameter must be set in the CPI web editor \(Configure\) before deploying, and recommend approving \*\*without\*\* deploy/)
    expect(flat).toMatch(/never configures a placeholder default as the parameter's value/)
  })

  test('5: callers of an HTTPS-triggered iFlow need ESBMessaging.send', () => {
    expect(flat).toMatch(/For an \*\*HTTPS-triggered\*\* iFlow, tell the user that its callers need credentials with the role `ESBMessaging\.send`: a service key of a \*\*Process Integration Runtime\*\* instance with plan \*\*integration-flow\*\*/)
  })
})

describe('system prompt: patterns loaded on demand (review item 6)', () => {
  const tools = require('../srv/agent/tools')
  const read = (n) => fs.readFileSync(path.join(__dirname, `../srv/agent/patterns/${n}.md`), 'utf8')

  test('the prompt keeps a pointer to each pattern, the details are only in the pattern', () => {
    expect(flat).toMatch(/When the user asks for ProcessDirect or one iFlow calling another, first call `getPattern` with `processDirect`/)
    expect(flat).toMatch(/v1 cannot build ProcessDirect; the HTTPS workaround is public and needs authentication/)
    expect(flat).toMatch(/To update, change, extend or fix an existing iFlow, first call `getPattern` with `updateIflow`/)
    expect(flat).toMatch(/Never call `proposeIflow` for an iFlow that already exists, and never list the changes yourself/)
    expect(flat).toMatch(/Before proposing or changing it, call `getPattern` with `importedIflow`/)
    expect(flat).not.toMatch(/CSRF Protected/) // moved
    expect(read('updateIflow')).toMatch(/SCRIPT_UNCHANGED/)
    expect(read('importedIflow')).toMatch(/useDraftSpec/)
  })

  test('getPattern returns a pattern; unknown names are an error', async () => {
    const def = tools.definitions.find((d) => d.function.name === 'getPattern')
    expect(def.function.parameters.properties.name.enum).toEqual(['processDirect', 'updateIflow', 'importedIflow', 'odata'])
    const ok = JSON.parse(await tools.execute('getPattern', JSON.stringify({ name: 'processDirect' }), {}))
    expect(ok).toMatchObject({ name: 'processDirect', pattern: expect.stringMatching(/^# Pattern: one iFlow calls another \(ProcessDirect\)/) })
    const bad = JSON.parse(await tools.execute('getPattern', JSON.stringify({ name: 'nope' }), {}))
    expect(bad).toMatchObject({ error: { code: 'UNKNOWN_PATTERN' } })
  })
})

describe('system prompt: OData and streaming (Test 3)', () => {
  const tools = require('../srv/agent/tools')
  const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/odata/filterProducts.groovy'), 'utf8')

  test('the prompt points to the odata pattern for /odata/ and .svc URLs and asks for streamed parsing', () => {
    expect(flat).toMatch(/when a receiver URL contains `\/odata\/` or `\.svc`, call `getPattern` with `odata`/)
    expect(flat).toMatch(/Parse the body \*\*streamed\*\*: `new JsonSlurper\(\)\.parse\(message\.getBody\(java\.io\.Reader\.class\)\)`/)
    expect(flat).toMatch(/never `parseText\(message\.getBody\(String\)\)`/)
  })

  test('the odata pattern covers V2, V4, string decimals and null safety, with the script that ran on CPI', async () => {
    const { pattern } = JSON.parse(await tools.execute('getPattern', JSON.stringify({ name: 'odata' }), {}))
    const p = pattern.replace(/\s+/g, ' ')
    expect(p).toMatch(/`\{"d": \{"results": \[ \.\.\. \]\}\}`/)
    expect(p).toMatch(/OData V4: `\{"value": \[ \.\.\. \]\}`/)
    expect(p).toMatch(/`new BigDecimal\(value\.toString\(\)\)`/)
    expect(p).toMatch(/Cannot get property 'UnitPrice' on null object/)
    expect(pattern).toContain(FIXTURE)
  })
})

