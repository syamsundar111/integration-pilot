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
// sections added only while a conversation needs them (srv/agent/agent.js PROMPT_SECTIONS)
const sectionFlat = (name) => fs.readFileSync(path.join(__dirname, `../srv/agent/prompt-sections/${name}.md`), 'utf8').replace(/\s+/g, ' ')
const routing = sectionFlat('routing')
const splitting = sectionFlat('splitting')

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
  // the detailed rules are a conditional section (added when the conversation mentions such steps)
  const flat = fs.readFileSync(path.join(__dirname, '../srv/agent/prompt-sections/unsupportedSteps.md'), 'utf8').replace(/\s+/g, ' ')
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
      name: 'PH_Multicast',
      description: "REPLACE WITH Parallel Multicast 'Send Orders': one branch to the ERP, one to the archive",
      properties: [{ name: 'REPLACE_WITH', type: 'constant', value: "Parallel Multicast 'Send Orders'" }]
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
    expect(flat).toMatch(/`authType: "OAuth2 Client Credentials"` and the `credentialName` the user gives.*\*\*Process Integration Runtime\*\* instance with plan \*\*integration-flow\*\*/)
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
  test('every XPath starts with / or // (a relative one finds nothing in CPI)', () => {
    expect(flat).toMatch(/Every XPath \(rows, Write Variables, splitter, gather\) starts with `\/` or `\/\/`: CPI evaluates it from the document root, so `id` finds nothing/)
  })

  test('constant for plain values, expression only with ${...}', () => {
    expect(flat).toMatch(/`constant` for a plain value, `expression` only when the value contains `\$\{\.\.\.\}`/)
  })
})

describe('system prompt: review items 1, 2, 4 and 5', () => {
  test('1: sensible defaults, questions only about real decisions, trivial fixes applied', () => {
    expect(flat).not.toMatch(/ask concise questions about what is missing/)
    expect(flat).toMatch(/\*\*Assume sensible defaults; ask only about real decisions\.\*\*/)
    expect(flat).toMatch(/\*\*Never ask about the package, the trigger or authentication\*\*/)
    for (const d of ['end: `none`', 'no exception subprocess unless the user asks', 'JSON in and out unless the user says otherwise', 'authentication: none (`authType: "None"`)'])
      expect(flat).toContain(d)
    expect(flat).toMatch(/trigger: `httpsSender` with the address made from the iFlow name in lower case, words joined by `-` \(e\.g\. "Order Intake" -> `\/order-intake`\)/)
    expect(flat).toMatch(/if they name none, do not look one up: set `packageId` to `NoPackageGiven`/)
    expect(flat).not.toMatch(/session defaults/i)
    expect(flat).toMatch(/\*\*values only the user can know\*\*: real\s+URLs, field rules/)
    expect(flat).toMatch(/Apply trivial fixes yourself and say so in one line, without asking: duplicate step names .*package ID characters/)
  })

  test('2: user code is used verbatim; a mistake in it is pointed out, not fixed without asking', () => {
    expect(flat).toMatch(/\*\*User code is the user's code\.\*\* Code the user gives in the message or attaches is used verbatim/)
    expect(flat).toMatch(/do not fix it on your own: point to the line and ask whether you may fix it/)
    expect(flat).toMatch(/Scripts are suggestions: they are not compiled or tested here, the developer tests them in CPI/)
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
    // phase 1b: routers on the main line, the default route last, spaces around Non-XML operators,
    // routes that end or continue; error handling ends with escalation (or error) for new iFlows
    expect(routing).toMatch(/except the \*\*default route\*\*: exactly one, `"default": true`, no condition, listed \*\*last\*\*/)
    expect(routing).toMatch(/NonXML: `\$\{property\.x\} = 'A'`, always with spaces around the operator/)
    expect(routing).toMatch(/If every route ends, the router must be the last step and the main `end` is `\{ "type": "none" \}`/)
    expect(flat).toMatch(/for a new iFlow use `escalation` \(or `error`\) unless the user asks for a response to the sender as the result/)
    // phase 1a tenant check: "with default value X" on a {{Param}} filled the Default Value column too
    expect(flat).toMatch(/For a `\{\{Param\}\}`, "default value" \/ "default" means the parameter's value in `parameters`\. Set a row's `default` \(the Content Modifier's Default Value column\) only when the user asks for that column explicitly/)
    // "okay" to a suggested name is an answer: the name is not asked again
    expect(flat).toMatch(/If the user agrees to a suggested name \("okay", "yes", "create a new one"\), use that name and the id it gives \(`Order_Intake_2`\) at once; do not ask for the name again/)
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

describe('system prompt: core and conditional sections', () => {
  test('the core keeps the key rules of the conditional sections', () => {
    expect(flat).toMatch(/Never suggest HTTP calls from Groovy, and never claim that a script splits a message\. An unsupported step becomes a placeholder Content Modifier `PH_<StepName>`/)
    expect(flat).toMatch(/Files of the conversation are listed in the Context\. Reference them by name and never retype their content/)
    expect(flat).not.toMatch(/What Groovy can and cannot replace/) // in the section
  })
})

describe('system prompt: scripts in batches ((d) run)', () => {
  test('with more than about 3 scripts: at most 3 writeScript calls per answer, then one proposeIflow', () => {
    expect(flat).toMatch(/With more than about 3 scripts, write them in batches: at most 3 `writeScript` calls per answer \(a longer answer hits the output limit\), then the spec in one `proposeIflow` call/)
  })
})


describe('system prompt: splitters and local processes (phase 2)', () => {
  test('the rules are in the splitting section; the core keeps a pointer to it and to the routing section (prompt size)', () => {
    expect(flat).toMatch(/Splitting: a `splitter` step runs the next steps once per item \(for each order, record, line\.\.\.\), until a `gather`/)
    expect(flat).toMatch(/if a section is missing, call `getSupportedSteps` with `topics: \["routing"\]` or `\["splitting"\]` before you use the step/)
    expect(flat).not.toMatch(/Always set `stopOnException`/) // the details are only in the section
    expect(flat).not.toMatch(/listed \*\*last\*\*/)
    expect(splitting).toMatch(/Always set `stopOnException`: `true` = one failing item stops the rest, `false` = the other items still run; if the request does not say, ask/)
    expect(splitting).toMatch(/there is no second splitter and \*\*no router\*\* between a splitter and its gather \(CPI refuses a router there\): to route each item, call a local process that contains the router/)
    expect(splitting).toMatch(/A router after a splitter without a gather is fine/)
    expect(splitting).toMatch(/`\{ "type": "gather", "name" \}`: XML Same Format, Combine; with `"source": "\/\/order", "target": "\/orders"` only when the request asks for Combine at XPath/)
    expect(splitting).toMatch(/Exchange properties set while processing one item do not reach the steps after the gather: results must travel in the message body/)
    expect(splitting).toMatch(/on the main line, in a route or in the exception subprocess/)
    expect(splitting).toMatch(/a route there continues or ends with a plain End, `\{ "event": "message" \}`, which returns to the caller: the flow goes on after the `processCall`/)
    expect(flat).not.toMatch(/Splitter and mapping are not supported/)
  })

  test('a spec from the examples in the prompt validates and builds', async () => {
    const spec = {
      ...sample,
      id: 'Prompt_Split',
      name: 'Prompt_Split',
      steps: [
        { type: 'splitter', name: 'Split Orders', kind: 'iterating', expression: '//order', stopOnException: true },
        { type: 'processCall', name: 'Handle Order', process: 'LIP_HandleOrder' },
        { type: 'gather', name: 'Gather Orders', source: '//order', target: '/orders' },
        { type: 'processCall', name: 'Fetch Pages', process: 'LIP_HandleOrder', loop: { condition: "${property.hasMore} = 'true'", max: 5 } }
      ],
      exceptionSubprocess: { steps: [{ type: 'processCall', process: 'LIP_HandleOrder' }], end: { event: 'escalation' } },
      localProcesses: [{ name: 'LIP_HandleOrder', steps: [{ type: 'contentModifier', properties: [{ name: 'hasMore', type: 'constant', value: 'false' }] }] }]
    }
    expect(validate(spec)).toMatchObject({ valid: true, warnings: [] })
    await expect(build(spec)).resolves.toBeTruthy()
  })
})

describe('system prompt: SOAP and Mail receivers (phase 3)', () => {
  const soap = sectionFlat('soap')
  const mail = sectionFlat('mail')
  test('the rules are in their sections, the core keeps a pointer', () => {
    expect(flat).toMatch(/`requestReplySoap` \(a SOAP 1\.x call\) and `sendMail` \(a one-way mail, also from the exception subprocess\)/)
    expect(flat).toMatch(/call `getSupportedSteps` with `topics: \["soap"\]` or `\["mail"\]` first/)
    expect(flat).not.toMatch(/STARTTLS/)
    expect(soap).toMatch(/Only Basic and On-Premise are supported/)
    expect(soap).toMatch(/There is no WSDL or operation: the message body is sent as it is/)
    expect(mail).toMatch(/`server`, `credentialName` and `to` can each be a whole `\{\{Param\}\}`/)
    expect(mail).toMatch(/in the exception subprocess \(an alert mail on error\)/)
  })

  test('a spec from the examples in the sections validates and builds', async () => {
    const spec = {
      ...sample,
      id: 'Prompt_SoapMail',
      name: 'Prompt_SoapMail',
      steps: [
        { type: 'requestReplySoap', name: 'Call', system: 'Erp', url: '{{ErpUrl}}', authType: 'Basic', credentialName: 'ERP_CRED', proxyType: 'On-Premise' },
        { type: 'sendMail', name: 'Tell', system: 'Smtp', server: 'smtp.example.com:587', credentialName: 'MAIL_CRED', from: 'a@example.com', to: 'a@example.com, b@example.com', subject: 'Done' }
      ],
      parameters: { ...sample.parameters, ErpUrl: 'http://s4dummy/x' },
      exceptionSubprocess: { steps: [{ type: 'sendMail', name: 'Alert', system: 'SmtpAlert', server: 'smtp.example.com:587', credentialName: 'MAIL_CRED', from: 'a@example.com', to: 'b@example.com', subject: 'Failed' }], end: { event: 'escalation' } }
    }
    expect(validate(spec)).toMatchObject({ valid: true, warnings: [] })
    await expect(build(spec)).resolves.toBeTruthy()
  })
})
