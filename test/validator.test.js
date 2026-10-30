const { validate, effectiveNames } = require('../srv/iflow-builder/validator')
const sample = require('../srv/iflow-builder/samples/Pilot_Test_1.json')
const schema = require('../srv/iflow-builder/spec-schema.json')
const { baseSpec, allStepsSpec, GROOVY } = require('./helpers')

const errorsOf = (spec) => validate(spec).errors
const expectError = (spec, re) => expect(errorsOf(spec).join('\n')).toMatch(re)

describe('validator', () => {
  test('accepts the sample, the reference-equivalent spec and the schema examples', async () => {
    expect(errorsOf(sample)).toEqual([])
    expect(errorsOf(await allStepsSpec())).toEqual([])
    for (const ex of schema.examples) expect(errorsOf(ex)).toEqual([])
  })

  test('accepts a timer flow without steps and without receiver', () => {
    expect(errorsOf(baseSpec({ trigger: { type: 'timer', mode: 'once' } }))).toEqual([])
  })

  test('rejects non-objects', () => {
    expect(validate(null)).toEqual({ valid: false, errors: ['spec: must be a JSON object'], issues: [{ code: 'NOT_OBJECT', message: 'spec: must be a JSON object' }] })
  })

  test('reports missing required fields', () => {
    const errors = errorsOf({ id: 'X' })
    expect(errors).toEqual(expect.arrayContaining(["spec: missing required field 'name'", "spec: missing required field 'trigger'"]))
  })

  test.each(['parallelMulticast', 'messageMapping'])('rejects %s with a clear message', (type) => {
    expectError(baseSpec({ steps: [{ type }] }), new RegExp(`steps\\[0\\]: '${type}' is not supported yet \\(no multicast, join or mapping\\)`))
  })

  test('another router type points to the router format (phase 1b)', () => {
    expectError(baseSpec({ steps: [{ type: 'contentBasedRouter' }] }), /steps\[0\]: 'contentBasedRouter' — a router is \{ "type": "router", "expressionType"/)
  })

  test('rejects unknown step, trigger and end types', () => {
    const errors = errorsOf(baseSpec({ steps: [{ type: 'magic' }], trigger: { type: 'sftp' }, end: { type: 'mail' } })).join('\n')
    expect(errors).toMatch(/steps\[0\]: unknown step type 'magic'/)
    expect(errors).toMatch(/trigger: 'sftp' is not supported yet/)
    expect(errors).toMatch(/end: 'mail' is not supported in v1/)
  })

  test('rejects invalid ids and unknown fields', () => {
    expectError(baseSpec({ id: 'bad id!' }), /^id: invalid value — use letters, digits and underscore/m)
    expectError(baseSpec({ steps: [{ type: 'jsonToXml', foo: 1 }] }), /steps\[0\]: unknown field 'foo'/)
  })

  test('requires the Groovy entry point and Message import', () => {
    const spec = baseSpec({ steps: [{ type: 'groovyScript', fileName: 'x', code: 'println "hi"' }] })
    expectError(spec, /steps\[0\]\.code: Groovy script must import com\.sap\.gateway\.ip\.core\.customdev\.util\.Message/)
    expectError(spec, /steps\[0\]\.code: Groovy script must define 'def Message processData\(Message message\)'/)
  })

  test('requires unique step names, script files and receiver systems', () => {
    const spec = baseSpec({
      steps: [
        { type: 'groovyScript', name: 'Same', fileName: 'a', code: GROOVY },
        { type: 'groovyScript', name: 'Same', fileName: 'a', code: GROOVY },
        { type: 'requestReplyHttp', system: 'Receiver', url: 'https://x.org', method: 'GET', authType: 'None' }
      ],
      end: { type: 'httpReceiver', url: 'https://y.org', method: 'POST', authType: 'None' }
    })
    const errors = errorsOf(spec).join('\n')
    expect(errors).toMatch(/step name 'Same' is used more than once/)
    expect(errors).toMatch(/Groovy fileName 'a' is used more than once/)
    expect(errors).toMatch(/receiver system name 'Receiver' is used more than once/)
  })

  test('default step names do not clash with explicit ones', () => {
    const spec = baseSpec({ steps: [{ type: 'jsonToXml', name: 'JSON to XML Converter 1' }, { type: 'jsonToXml' }] })
    expect(errorsOf(spec)).toEqual([])
    expect(effectiveNames(spec).steps).toEqual(['JSON to XML Converter 1', 'JSON to XML Converter 2'])
  })

  describe('phase 1a: timer every N minutes, Content Modifier sources, Write Variables', () => {
    test('a timer every N minutes needs minutes, and only intervals of the reference exports', () => {
      expect(errorsOf(baseSpec({ trigger: { type: 'timer', mode: 'every', minutes: 15 } }))).toEqual([])
      expect(errorsOf(baseSpec({ trigger: { type: 'timer', mode: 'every' } }))).toEqual(["trigger: missing required field 'minutes' (the interval of mode every)"])
      expect(errorsOf(baseSpec({ trigger: { type: 'timer', mode: 'every', minutes: 5 } }))).toEqual(["trigger: every '5' is in no reference export (known: 15)"])
      expect(errorsOf(baseSpec({ trigger: { type: 'timer', mode: 'once', minutes: 15 } }))).toEqual(['trigger.minutes: only used with mode every — remove it, or set mode "every"'])
    })

    test('Content Modifier sources: header, property, xpath, global and local variable; unknown types are refused', () => {
      const cm = (type) => baseSpec({ steps: [{ type: 'contentModifier', properties: [{ name: 'p', type, value: 'X' }] }] })
      for (const type of ['header', 'property', 'xpath', 'globalVariable', 'localVariable']) expect([type, errorsOf(cm(type))]).toEqual([type, []])
      expect(errorsOf(cm('numberRange'))).toEqual([expect.stringMatching(/^steps\[0\]\.properties\[0\]\.type: must be one of constant, expression, header, property, xpath, globalVariable, localVariable/)])
    })

    test('Write Variables: property or xpath, in the main flow only', () => {
      const wv = { type: 'writeVariables', variables: [{ name: 'LAST_RUN', type: 'property', value: 'runTimestamp', global: true }] }
      expect(errorsOf(baseSpec({ steps: [wv] }))).toEqual([])
      expect(errorsOf(baseSpec({ steps: [{ ...wv, variables: [{ name: 'A', type: 'constant', value: 'x' }] }] }))).toEqual(['steps[0].variables[0].type: must be one of property, xpath'])
      expect(errorsOf(baseSpec({ steps: [{ ...wv, variables: [] }] }))).toEqual([expect.stringMatching(/^steps\[0\]\.variables: must NOT have fewer than 1 items/)])
      const inException = errorsOf(baseSpec({ exceptionSubprocess: { steps: [wv] } }))
      expect(inException).toEqual([expect.stringMatching(/^exceptionSubprocess\.steps\[0\]: 'writeVariables' is not supported in the exception subprocess/)])
    })
  })

  describe('HTTP receivers: authentication, proxy and timeout', () => {
    const end = (e) => baseSpec({ end: { type: 'httpReceiver', url: 'https://x.org', method: 'POST', ...e } })
    const rr = (e) => baseSpec({ steps: [{ type: 'requestReplyHttp', url: 'https://x.org', method: 'GET', ...e }] })

    test('None, Basic and OAuth2 Client Credentials with a credential name; Internet or On-Premise with a location ID; a timeout', () => {
      expect(errorsOf(end({ authType: 'None' }))).toEqual([])
      expect(errorsOf(end({ authType: 'Basic', credentialName: 'ERP_BASIC_USER' }))).toEqual([])
      expect(errorsOf(rr({ authType: 'OAuth2 Client Credentials', credentialName: 'OAUTH.CLIENT-1', proxyType: 'On-Premise', locationId: 'LOC_1', timeout: 30000 }))).toEqual([])
      expect(errorsOf(rr({ authType: 'None', proxyType: 'Internet', timeout: 1 }))).toEqual([])
    })

    test('a credential name is required with Basic and OAuth2, and only used with them', () => {
      expect(errorsOf(end({ authType: 'Basic' }))).toEqual([expect.stringMatching(/^end\.credentialName: required with authType Basic — give the name of the security material deployed in CPI/)])
      expect(errorsOf(end({ authType: 'None', credentialName: 'X' }))).toEqual([expect.stringMatching(/^end\.credentialName: only used with authType Basic or OAuth2 Client Credentials/)])
      expect(errorsOf(rr({ authType: 'Basic', credentialAlias: 'A' }))).toEqual([expect.stringMatching(/^steps\[0\]: unknown field 'credentialAlias' — use credentialName/)])
    })

    test('other methods and proxy types, and a location ID without On-Premise, are refused', () => {
      expect(errorsOf(end({ authType: 'Client Certificate' }))).toEqual(['end.authType: must be one of None, Basic, OAuth2 Client Credentials'])
      expect(errorsOf(end({ authType: 'None', proxyType: 'Manual' }))).toEqual(['end.proxyType: must be one of Internet, On-Premise'])
      expect(errorsOf(end({ authType: 'None', locationId: 'LOC' }))).toEqual([expect.stringMatching(/^end\.locationId: only used with proxyType On-Premise/)])
      expectError(end({ authType: 'None', timeout: 0 }), /end\.timeout/)
    })

    test('credentials never go into the spec: passwords, secrets, user:password URLs; credential name and location ID may be parameters', () => {
      const secret = errorsOf(rr({ authType: 'Basic', credentialName: 'C', password: 'hunter2', clientSecret: 'abc' }))
      expect(secret).toEqual([expect.stringMatching(/^steps\[0\]\.password: never put credentials into the spec/), expect.stringMatching(/^steps\[0\]\.clientSecret: never put credentials into the spec/)])
      expectError(end({ authType: 'None', url: 'https://user:secret@x.org/api' }), /end\.url: contains user:password/)
      const withParams = (e) => ({ ...rr(e), parameters: { Cred: 'ERP_BASIC_USER', Loc: 'LOC_1' } })
      expect(errorsOf(withParams({ authType: 'Basic', credentialName: '{{Cred}}', proxyType: 'On-Premise', locationId: '{{Loc}}' }))).toEqual([])
      expect(errorsOf(rr({ authType: 'Basic', credentialName: '{{Cred}}' }))).toEqual(["steps[0].credentialName: parameter 'Cred' is referenced but not defined in 'parameters'"])
      expect(errorsOf(withParams({ authType: 'Basic', credentialName: 'ERP_{{Cred}}' }))).toEqual([expect.stringMatching(/^steps\[0\]\.credentialName: a parameter must be the whole value/)])
      expect(errorsOf(rr({ authType: 'Basic', credentialName: 'my credential' }))).toEqual([expect.stringMatching(/^steps\[0\]\.credentialName: invalid value — use the name of the deployed credential/)])
    })

    test('a value seen in only one reference export warns unless it is confirmed (re-selected in the CPI editor)', () => {
      // OAuth2 Client Credentials and On-Premise are each in one reference, both confirmed
      expect(validate(rr({ authType: 'OAuth2 Client Credentials', credentialName: 'C', proxyType: 'On-Premise' })).warnings).toEqual([])
      const { checkAgainstReferences } = require('../srv/iflow-builder/receiver-settings')
      const values = { 'HTTP Receiver': { proxyType: { default: { references: ['A', 'B'] }, sapcc: { references: ['A'] } }, authenticationMethod: { Basic: { references: ['A'] } } } }
      expect(checkAgainstReferences({ authType: 'Basic', credentialName: 'C', proxyType: 'On-Premise' }, 'end', values)).toEqual({
        errors: [],
        warnings: [
          "end: authenticationMethod 'Basic' is seen in only one reference export (A) and not yet confirmed in the CPI editor",
          "end: proxyType 'sapcc' is seen in only one reference export (A) and not yet confirmed in the CPI editor"
        ]
      })
      values['HTTP Receiver'].proxyType.sapcc.confirmed = 'test'
      expect(checkAgainstReferences({ authType: 'None', proxyType: 'On-Premise' }, 'end', values).errors).toEqual(["end: authenticationMethod 'None' is in no reference export (known: Basic)"])
    })
  })

  test('rejects plaintext secrets in headers, body and Groovy', () => {
    const cm = { type: 'contentModifier', headers: [{ name: 'Authorization', type: 'constant', value: 'Basic dXNlcjpwYXNz' }], body: '{"password":"hunter2"}' }
    const groovy = { type: 'groovyScript', fileName: 'g', code: GROOVY.replace('return', 'def password = "hunter2"\n    return') }
    const errors = errorsOf(baseSpec({ steps: [cm, groovy] })).join('\n')
    expect(errors).toMatch(/steps\[0\]\.headers\[0\]: 'Authorization' looks like a secret/)
    expect(errors).toMatch(/steps\[0\]\.body: contains a plaintext secret/)
    expect(errors).toMatch(/steps\[1\]\.code: contains a hard-coded secret/)
  })

  test('allows secret-like header names with expressions (no plaintext value)', () => {
    const cm = { type: 'contentModifier', headers: [{ name: 'Authorization', type: 'expression', value: '${property.token}' }] }
    expect(errorsOf(baseSpec({ steps: [cm] }))).toEqual([])
  })

  test('checks externalized parameters', () => {
    const undefinedParam = baseSpec({ end: { type: 'httpReceiver', url: '{{Missing}}', method: 'POST', authType: 'None' } })
    expectError(undefinedParam, /end\.url: parameter 'Missing' is referenced but not defined/)

    // a constant header or property may be a whole parameter (an externalized value); an expression may not
    const constantValue = baseSpec({ steps: [{ type: 'contentModifier', headers: [{ name: 'X', type: 'constant', value: '{{P}}' }] }], parameters: { P: 'v' } })
    expect(errorsOf(constantValue)).toEqual([])
    const wrongPlace = baseSpec({ steps: [{ type: 'contentModifier', headers: [{ name: 'X', type: 'expression', value: '{{P}}' }] }], parameters: { P: 'v' } })
    expectError(wrongPlace, /steps\[0\]\.headers\[0\]\.value: parameters .* can only be used as the whole url, credentialName or locationId of an HTTP receiver, the url of a SOAP receiver, the server, credentialName or to of a mail, or as a constant value/)

    const senderParam = baseSpec({ trigger: { type: 'httpsSender', address: '{{Path}}' }, parameters: { Path: '/x' } })
    expectError(senderParam, /trigger\.address: parameters .* can only be used as the whole url, credentialName or locationId of an HTTP receiver/)
    expectError(senderParam, /trigger\.address: invalid value — use a path like \/orders\/create/)

    const partial = baseSpec({ end: { type: 'httpReceiver', url: 'https://x.org/{{P}}', method: 'POST', authType: 'None' }, parameters: { P: 'x' } })
    expectError(partial, /end\.url: a parameter must be the whole value/)
  })

  test('every error has a stable code', () => {
    const spec = baseSpec({
      steps: [
        { type: 'contentModifier', name: 'A' },
        { type: 'contentModifier', name: 'A', headers: [{ name: 'X', type: 'numberRange', value: '/a' }] },
        { type: 'messageMapping' },
        ...Array.from({ length: 49 }, () => ({ type: 'jsonToXml' }))
      ],
      end: { type: 'httpReceiver', url: '{{Missing}}', method: 'POST', authType: 'Basic' } // no credentialName
    })
    const { issues, errors } = validate(spec)
    expect(issues.map((i) => i.message)).toEqual(errors)
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(['STEP_NOT_IN_V1', 'CREDENTIAL_MISSING', 'BAD_VALUE', 'TOO_MANY', 'DUPLICATE_STEP_NAME', 'PARAM_UNDEFINED']))
  })

  test('start and end events listed as steps point to the top-level fields', () => {
    const { issues } = validate(baseSpec({ steps: [{ type: 'timer' }, { type: 'jsonToXml' }, { type: 'none' }] }))
    expect(issues.map((i) => i.code)).toEqual(['TRIGGER_AS_STEP', 'END_AS_STEP'])
    expect(issues[1].message).toMatch(/steps\[2\]: 'none' is the end of the flow, not a step — remove it from steps; the end is the top-level 'end'/)
  })

  test('the main flow takes up to 50 steps; 50 also build', async () => {
    const steps = (n) => Array.from({ length: n }, (_, i) => ({ type: 'contentModifier', name: `Step ${i + 1}` }))
    expect(validate(baseSpec({ steps: steps(50) })).valid).toBe(true)
    expect(validate(baseSpec({ steps: steps(51) })).issues).toEqual([expect.objectContaining({ code: 'TOO_MANY', message: 'steps: must NOT have more than 50 items' })])
    const { build } = require('../srv/iflow-builder/builder')
    const { files } = await build(baseSpec({ steps: steps(50) }))
    expect(files.find((f) => f.path.endsWith('.iflw')).content.match(/<bpmn2:callActivity /g)).toHaveLength(50)
  })

  test('{{…}} in a step description is documentation, not a parameter', () => {
    const spec = baseSpec({ steps: [{ type: 'contentModifier', name: 'Note', description: 'Manual: schedule {{Scheduler}} every 2 minutes' }] })
    expect(validate(spec).errors).toEqual([])
    const inValue = baseSpec({ steps: [{ type: 'contentModifier', name: 'Note', headers: [{ name: 'X', type: 'expression', value: '{{Scheduler}}' }] }] })
    expect(validate(inValue).issues.map((i) => i.code)).toEqual(['PARAM_NOT_URL'])
  })
})

describe('duplicate names say where and what to do ((d) run: three identical failures in a row)', () => {
  const { baseSpec } = require('./helpers')
  const script = { type: 'groovyScript', name: 'Script_SetCustomHeaders_Exc', fileName: 'Script_SetCustomHeaders_Exc' }
  const cm = { type: 'contentModifier', name: 'CM_SetMessage', properties: [{ name: 'x', type: 'constant', value: '1' }] }

  test('the same step added twice: both positions and the removeStep to send', () => {
    const r = validate(baseSpec({ steps: [{ type: 'jsonToXml', name: 'A' }], exceptionSubprocess: { steps: [cm, script, script] } }), { attachments: ['Script_SetCustomHeaders_Exc.groovy'] })
    const fix = 'the same step was added twice: remove exceptionSubprocess.steps[2] (editDraftSpec {"op":"removeStep","index":2,"exception":true})'
    expect(r.errors).toEqual([
      `steps: step name 'Script_SetCustomHeaders_Exc' is used more than once, at exceptionSubprocess.steps[1] and exceptionSubprocess.steps[2] — step names must be unique (main flow, routes, exception subprocess and local processes together); ${fix}`,
      `steps: Groovy fileName 'Script_SetCustomHeaders_Exc' is used more than once, at exceptionSubprocess.steps[1] and exceptionSubprocess.steps[2] — each script needs its own file; ${fix}`
    ])
  })

  test('different steps with one name: rename or remove', () => {
    const r = validate(baseSpec({ steps: [{ type: 'jsonToXml', name: 'Convert' }, { type: 'xmlToJson', name: 'Convert' }] }))
    expect(r.errors).toEqual([
      `steps: step name 'Convert' is used more than once, at steps[0] and steps[1] — step names must be unique (main flow, routes, exception subprocess and local processes together); rename all but one, or remove the extra step (editDraftSpec {"op":"removeStep","index":1})`
    ])
  })
})

describe('characters (full review: MANIFEST injection and control characters)', () => {
  const { baseSpec } = require('./helpers')
  const { manifestHeader } = require('../srv/iflow-builder/builder')
  const { parseManifest } = require('../srv/iflow-builder/parser')

  test('a line break in a name or id is refused; descriptions and bodies may span lines', () => {
    expect(validate(baseSpec({ name: 'X\nSAP-BundleType: Evil' })).errors).toEqual(['name: must be one line — remove line breaks and tabs'])
    expect(validate(baseSpec({ steps: [{ type: 'jsonToXml', name: 'a\tb' }] })).errors).toEqual(['steps[0].name: must be one line — remove line breaks and tabs'])
    expect(validate(baseSpec({ description: 'line 1\nline 2', steps: [{ type: 'contentModifier', name: 'C', body: '{\n  "a": 1\n}' }] })).valid).toBe(true)
  })

  test('control characters are refused anywhere (XML 1.0 does not allow them)', () => {
    const r = validate(baseSpec({ steps: [{ type: 'contentModifier', name: 'C', headers: [{ name: 'H', type: 'constant', value: 'a\u0001b' }] }] }))
    expect(r.errors).toEqual(['steps[0].headers[0].value: contains a control character — remove it'])
  })

  test('MANIFEST.MF folding never splits a UTF-8 character, and a line break cannot add a header', () => {
    const long = 'ä'.repeat(60) + '€🙂'.repeat(10)
    const h = manifestHeader('Bundle-Name', long)
    expect(h.split('\r\n').filter(Boolean).every((l) => Buffer.byteLength(l) <= 72)).toBe(true)
    expect(parseManifest(h)['Bundle-Name']).toBe(long)
    expect(Object.keys(parseManifest(manifestHeader('Bundle-Name', 'X\nSAP-BundleType: Evil')))).toEqual(['Bundle-Name'])
  })
})

describe('routers (phase 1b)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: '1' }] })
  const router = (routes, expressionType = 'NonXML') => ({ type: 'router', name: 'RT', expressionType, routes })
  const errs = (steps, end) => errorsOf(baseSpec({ steps, ...(end && { end }) }))

  test('a valid router: conditions, a default route listed last, a route that ends', () => {
    expect(errs([cm('A'), router([{ name: 'R1', condition: "${property.k} = 'A'", steps: [cm('B')] }, { name: 'R2', default: true, end: { event: 'error' } }]), cm('C')])).toEqual([])
  })

  test('exactly one default route, listed last, without a condition; every other route has a condition', () => {
    expect(errs([router([{ name: 'R1', default: true }, { name: 'R2', default: true }])])).toEqual([expect.stringMatching(/^steps\[0\]\.routes: exactly one route needs "default": true \(found 2\)/)])
    expect(errs([router([{ name: 'R2', default: true }, { name: 'R1', condition: '${a} = 1' }])])).toEqual(["steps[0].routes: list the default route 'R2' last — CPI evaluates it last"])
    expect(errs([router([{ name: 'R1' }, { name: 'R2', default: true }])])).toEqual(["steps[0].routes[0]: a route that is not the default needs a 'condition'"])
    expect(errs([router([{ name: 'R1', condition: '${a} = 1' }, { name: 'R2', default: true, condition: '${b} = 2' }])])).toEqual(["steps[0].routes[1]: the default route has no condition — remove 'condition'"])
  })

  test('Non-XML conditions need spaces around the operator; XML conditions are XPath', () => {
    expect(errs([router([{ name: 'R1', condition: "${property.x}='A'" }, { name: 'R2', default: true }])])).toEqual([
      'steps[0].routes[0].condition: put spaces around the operator, e.g. "${property.x} = \'A\'", not "${property.x}=\'A\'"'
    ])
    for (const ok of ["${property.x} != 'A'", '${header.n} >= 5', "${property.a} = 'x=y'"]) expect([ok, errs([router([{ name: 'R1', condition: ok }, { name: 'R2', default: true }])])]).toEqual([ok, []])
    expect(errs([router([{ name: 'R1', condition: '${a} = 1' }, { name: 'R2', default: true }], 'XML')])).toEqual([expect.stringMatching(/^steps\[0\]\.routes\[0\]\.condition: an XML condition is an XPath/)])
  })

  test('if every route ends, the router is the last step and the main end is "none"', () => {
    const allEnd = router([{ name: 'R1', condition: '${a} = 1', end: { event: 'message' } }, { name: 'R2', default: true, end: { event: 'error' } }])
    expect(errs([allEnd])).toEqual([])
    expect(errs([allEnd, cm('C')])).toEqual([expect.stringMatching(/^steps\[0\]: every route ends, so the steps after the router can never run/)])
    expect(errs([allEnd], { type: 'httpReceiver', url: 'https://x.example.com', method: 'POST', authType: 'None' })).toEqual([
      'end: every route of the last router ends, so the main flow has no end of its own — set "end": { "type": "none" }'
    ])
  })

  test('routers only on the main line; route names unique; 50 steps counting routers and route steps', () => {
    const nested = router([{ name: 'R1', condition: '${a} = 1', steps: [{ ...router([{ name: 'X', condition: '${b} = 1' }, { name: 'Y', default: true }]), name: 'Inner' }] }, { name: 'R2', default: true }])
    expect(errs([nested])).toEqual([expect.stringMatching(/^steps\[0\]\.routes\[0\]\.steps\[0\]: a router inside a route is not supported/)])
    expect(errs([router([{ name: 'R', condition: '${a} = 1' }, { name: 'R', default: true }])])).toEqual([
      "steps[0].routes: route name 'R' is used more than once — route names must be unique within a router"
    ])
    const big = router([{ name: 'R1', condition: '${a} = 1', steps: Array.from({ length: 30 }, (_, i) => cm(`S${i}`)) }, { name: 'R2', default: true }])
    const main = Array.from({ length: 20 }, (_, i) => cm(`M${i}`))
    expect(errs([...main, big])).toEqual(['steps: 51 steps with the routers and the steps inside routes — at most 50 per process; merge Content Modifiers or move logic into one Groovy script'])
  })

  test('end events: message, escalation or error; a receiver end is a Message End', () => {
    expect(errorsOf(baseSpec({ end: { type: 'none', event: 'escalation' } }))).toEqual([])
    expect(errorsOf(baseSpec({ exceptionSubprocess: { steps: [cm('E')], end: { event: 'escalation', name: 'Escalate' } } }))).toEqual([])
    expect(errorsOf(baseSpec({ end: { type: 'none', event: 'terminate' } }))).toEqual(['end.event: must be one of message, escalation, error'])
    expect(errorsOf(baseSpec({ end: { type: 'httpReceiver', url: 'https://x.example.com', method: 'POST', authType: 'None', event: 'error' } }))).toEqual([
      "end: unknown field 'event'"
    ])
  })
})

describe('Escalation End category (phase 1b)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: '1' }] })
  test('Others (default) or RoutingConditionNotMet, only on an Escalation End', () => {
    expect(errorsOf(baseSpec({ end: { type: 'none', event: 'escalation' } }))).toEqual([])
    expect(errorsOf(baseSpec({ end: { type: 'none', event: 'escalation', category: 'RoutingConditionNotMet' } }))).toEqual([])
    expect(errorsOf(baseSpec({ exceptionSubprocess: { steps: [cm('E')], end: { event: 'escalation', category: 'Others' } } }))).toEqual([])
    expect(errorsOf(baseSpec({ end: { type: 'none', event: 'error', category: 'Others' } }))).toEqual([
      'end.category: only an Escalation End has a category — remove it, or set "event": "escalation"'
    ])
    expect(errorsOf(baseSpec({ end: { type: 'none', event: 'escalation', category: 'ReceiverNotFound' } }))).toEqual(['end.category: must be one of Others, RoutingConditionNotMet'])
  })
})

describe('splitters, gathers, process calls and local processes (phase 2)', () => {
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: name }] })
  const split = (name, extra = {}) => ({ type: 'splitter', name, kind: 'iterating', expression: '//item', stopOnException: false, ...extra })
  const gather = (name) => ({ type: 'gather', name, source: '//item', target: '/items' })
  const local = (name, steps = [cm(`${name}_CM`)]) => ({ name, steps })
  const issues = (spec) => validate(spec).issues

  const router = (name = 'R') => ({ type: 'router', name, expressionType: 'NonXML', routes: [{ name: 'A', condition: '${property.x} = 1', steps: [cm(`${name}_InRoute`)] }, { name: 'D', default: true }] })

  test('a split closed by a gather, a second split after it that runs to the end with a router: valid without warnings', () => {
    const spec = baseSpec({ steps: [split('S1'), cm('B'), gather('G1'), split('S2', { kind: 'general', expression: '/a/item', stopOnException: true }), router(), cm('C')] })
    expect(validate(spec)).toMatchObject({ valid: true, warnings: [] })
  })

  test('no router between a splitter and its gather (CPI refuses it): the message points to a local process with the router', () => {
    expect(issues(baseSpec({ steps: [split('S1'), router(), gather('G1')] }))).toEqual([
      {
        code: 'ROUTER_IN_SPLIT',
        message:
          'steps[1]: CPI does not accept a router between a splitter and its gather (steps[2]) — route per item inside a local process instead: a processCall here, and a local process that contains the router (a router after a splitter without a gather is fine)'
      }
    ])
    // the supported form
    const perItem = baseSpec({ steps: [split('S1'), { type: 'processCall', name: 'PC', process: 'L' }, gather('G1')], localProcesses: [{ name: 'L', steps: [cm('L1'), router('LR')] }] })
    expect(validate(perItem)).toMatchObject({ valid: true, warnings: [] })
  })

  test('routers in local processes: the main-line rules apply; no nested router; a route ends with a plain End only', () => {
    const lp = (steps) => baseSpec({ steps: [{ type: 'processCall', name: 'PC', process: 'L' }], localProcesses: [{ name: 'L', steps }] })
    expectError(lp([{ type: 'router', name: 'LR', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a}=1' }, { name: 'D', default: true }] }]), /localProcesses\[0\]\.steps\[0\]\.routes\[0\]\.condition: put spaces around the operator/)
    expectError(lp([{ type: 'router', name: 'LR', expressionType: 'NonXML', routes: [{ name: 'D', default: true }, { name: 'A', condition: '${a} = 1' }] }]), /localProcesses\[0\]\.steps\[0\]\.routes: list the default route 'D' last/)
    const nested = { type: 'router', name: 'LR', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1', steps: [router('Inner')] }, { name: 'D', default: true }] }
    expect(issues(lp([nested])).map((i) => i.code)).toEqual(['NESTED_ROUTER'])
    const ending = (end) => ({ type: 'router', name: 'LR', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1', end }, { name: 'D', default: true }] })
    expect(validate(lp([ending({ event: 'message' }), cm('After')]))).toMatchObject({ valid: true, warnings: [] })
    expect(issues(lp([ending({ event: 'escalation' })]))).toEqual([
      { code: 'LOCAL_END_EVENT', message: 'localProcesses[0].steps[0].routes[0].end: a route in a local process ends with a plain End ({ "event": "message" }) — Escalation and Error Ends in local processes are not supported yet' }
    ])
    // every route ends: the router is the last step of the local process
    const allEnd = { type: 'router', name: 'LR', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1', end: { event: 'message' } }, { name: 'D', default: true, end: { event: 'message' } }] }
    expectError(lp([allEnd, cm('Never')]), /localProcesses\[0\]\.steps\[0\]: every route ends, so the steps after the router can never run/)
    expect(validate(lp([cm('First'), allEnd]))).toMatchObject({ valid: true })
  })

  test('stopOnException has no default: missing, the message says what true and false mean', () => {
    const { stopOnException, ...noStop } = split('S')
    expectError(baseSpec({ steps: [noStop] }), /steps\[0\]: missing required field 'stopOnException' — true: one failing item stops the rest; false: the other items still run/)
  })

  test('no nested split, no gather without a splitter, only on the main line', () => {
    expect(issues(baseSpec({ steps: [split('S1'), split('S2'), gather('G')] }))).toEqual([
      { code: 'NESTED_SPLIT', message: expect.stringMatching(/^steps\[1\]: a splitter between the splitter steps\[0\] and its gather is not supported \(no nested splits\)/) }
    ])
    expect(issues(baseSpec({ steps: [cm('A'), gather('G')] }))).toEqual([{ code: 'GATHER_WITHOUT_SPLITTER', message: expect.stringMatching(/^steps\[1\]: a gather combines split messages — put a splitter before it/) }])
    const inRoute = { type: 'router', name: 'R', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${property.x} = 1', steps: [split('S')] }, { name: 'D', default: true }] }
    expect(issues(baseSpec({ steps: [inRoute] }))).toEqual([{ code: 'MAIN_LINE_ONLY', message: expect.stringMatching(/^steps\[0\]\.routes\[0\]\.steps\[0\]: a splitter inside a route is not supported/) }])
    expectError(baseSpec({ steps: [cm('A')], exceptionSubprocess: { steps: [split('S')] } }), /exceptionSubprocess\.steps\[0\]: 'splitter' is not supported in the exception subprocess/)
  })

  test('only the reference values: parallel processing off; streaming on or off (both confirmed in Ref_Structure)', () => {
    expectError(baseSpec({ steps: [split('S', { parallel: true })] }), /steps\[0\]\.parallel: must be 'false'/)
    expect(validate(baseSpec({ steps: [split('S', { streaming: false })] }))).toMatchObject({ valid: true, warnings: [] })
  })

  test('a process call names an existing local process; a loop condition is NonXML with spaces', () => {
    expect(issues(baseSpec({ steps: [{ type: 'processCall', name: 'PC', process: 'Missing' }], localProcesses: [local('L')] }))).toEqual([
      { code: 'PROCESS_UNKNOWN', message: expect.stringMatching(/^steps\[0\]\.process: no local process 'Missing' — add it to localProcesses.*or call one of: L$/) }
    ])
    const loop = (condition) => baseSpec({ steps: [{ type: 'processCall', name: 'PC', process: 'L', loop: { condition, max: 3 } }], localProcesses: [local('L')] })
    expect(validate(loop("${property.more} = 'true'"))).toMatchObject({ valid: true, warnings: [] })
    expectError(loop("${property.more}='true'"), /steps\[0\]\.loop\.condition: put spaces around the operator/)
    expectError(loop('/root/more'), /steps\[0\]\.loop\.condition: a NonXML condition reads a header or property/)
    expectError(baseSpec({ steps: [{ type: 'processCall', name: 'PC', process: 'L', loop: { condition: '${a} = 1' } }], localProcesses: [local('L')] }), /steps\[0\]\.loop: missing required field 'max'/)
  })

  test('process calls on the main line, in routes and in the exception subprocess; not in a local process', () => {
    const call = (name) => ({ type: 'processCall', name, process: 'L' })
    const router = { type: 'router', name: 'R', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1', steps: [call('InRoute')], end: { event: 'escalation' } }, { name: 'D', default: true }] }
    expect(validate(baseSpec({ steps: [call('Main'), router], exceptionSubprocess: { steps: [call('OnError')] }, localProcesses: [local('L')] }))).toMatchObject({ valid: true, warnings: [] })
    expect(issues(baseSpec({ steps: [call('Main')], localProcesses: [local('L'), local('L2', [call('Inner')])] }))).toEqual([
      { code: 'LOCAL_STEP_UNSUPPORTED', message: expect.stringMatching(/^localProcesses\[1\]\.steps\[0\]: a processCall inside a local process is not supported yet \(no splitters, gathers or process calls there\)/) }
    ])
  })

  test('local processes: unique names, a warning when nothing calls one, each with its own limit of 50, names unique with the main flow', () => {
    expect(validate(baseSpec({ steps: [cm('A')], localProcesses: [local('L')] })).warnings).toEqual(["localProcesses[0]: no processCall calls the local process 'L', so it never runs"])
    expectError(baseSpec({ steps: [{ type: 'processCall', process: 'L' }], localProcesses: [local('L'), local('L', [cm('B')])] }), /local process name 'L' is used more than once/)
    expectError(baseSpec({ steps: [cm('A'), { type: 'processCall', process: 'L' }], localProcesses: [local('L', [cm('A')])] }), /step name 'A' is used more than once, at steps\[0\] and localProcesses\[0\]\.steps\[0\]/)
    const many = (n, prefix) => Array.from({ length: n }, (_, i) => cm(`${prefix}${i}`))
    // 50 on the main flow and 50 in each local process
    const call = { type: 'processCall', process: 'L' }
    expect(validate(baseSpec({ steps: [call, ...many(49, 'M')], localProcesses: [local('L', many(50, 'A')), { name: 'Unused', steps: many(50, 'B') }] })).valid).toBe(true)
    // over it: counted with the steps inside routes, the message names the local process
    const routed = { type: 'router', name: 'LR', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1', steps: many(30, 'R') }, { name: 'D', default: true }] }
    expect(issues(baseSpec({ steps: [call], localProcesses: [local('L', [...many(20, 'A'), routed])] }))).toEqual([
      { code: 'TOO_MANY_STEPS', message: "localProcesses[0] 'L': 51 steps with the routers and the steps inside routes — at most 50 per process; merge Content Modifiers or move logic into one Groovy script" }
    ])
  })

  test('effectiveNames: default names count over the local processes too, receivers get unique systems', () => {
    const names = effectiveNames(
      baseSpec({
        steps: [{ type: 'requestReplyHttp', url: 'https://a.example.com', method: 'GET', authType: 'None' }, { type: 'processCall', process: 'L' }],
        localProcesses: [{ name: 'L', steps: [{ type: 'requestReplyHttp', url: 'https://b.example.com', method: 'GET', authType: 'None' }, { type: 'jsonToXml' }] }]
      })
    )
    expect(names.flat.map((x) => [x.name, x.system])).toEqual([['Request Reply 1', 'Receiver1'], ['Process Call 1', null]])
    expect(names.local.map((x) => [x.name, x.system, x.where])).toEqual([['Request Reply 2', 'Receiver2', 'localProcesses[0].steps[0]'], ['JSON to XML Converter 1', null, 'localProcesses[0].steps[1]']])
  })

  test('old names for the new steps point to their format', () => {
    expectError(baseSpec({ steps: [{ type: 'iteratingSplitter' }] }), /steps\[0\]: 'iteratingSplitter' — a splitter is \{ "type": "splitter", "kind": "iterating"\|"general"/)
    expectError(baseSpec({ steps: [{ type: 'loopingProcessCall' }] }), /steps\[0\]: 'loopingProcessCall' — a process call is \{ "type": "processCall"/)
    expectError(baseSpec({ steps: [{ type: 'exceptionSubprocess' }] }), /error handling is not a step/)
  })
})

describe('relative XPaths: a note (CPI evaluates them from the document root: only a path that starts with the root element works)', () => {
  test('rows, Write Variables, splitter and gather XPaths that do not start with / or // get a note; functions do not', () => {
    const spec = baseSpec({
      steps: [
        { type: 'splitter', name: 'S', kind: 'iterating', expression: 'order', stopOnException: false },
        { type: 'contentModifier', name: 'CM', headers: [{ name: 'orderId', type: 'xpath', value: 'id' }, { name: 'ok', type: 'xpath', value: '/order/id' }, { name: 'n', type: 'xpath', value: 'count(//item)' }] },
        { type: 'writeVariables', name: 'WV', variables: [{ name: 'V', type: 'xpath', value: './id' }] },
        { type: 'gather', name: 'G', source: '//order', target: 'orders' }
      ]
    })
    const r = validate(spec)
    expect(r.valid).toBe(true)
    const note = (where, v) =>
      `${where}: the XPath '${v}' is relative; CPI evaluates it from the document root, so it only works if it starts with the root element (e.g. 'order/${v.replace(/^\.\//, '')}'). Safer: start it with / or //, e.g. '/order/${v.replace(/^\.\//, '')}'`
    expect(r.warnings).toEqual([note('steps[0].expression', 'order'), note('steps[1].headers[0].value', 'id'), note('steps[2].variables[0].value', './id'), note('steps[3].target', 'orders')])
    expect(r.warnings[1]).toBe(
      "steps[1].headers[0].value: the XPath 'id' is relative; CPI evaluates it from the document root, so it only works if it starts with the root element (e.g. 'order/id'). Safer: start it with / or //, e.g. '/order/id'"
    )
  })
})

describe('SOAP 1.x and Mail receivers (phase 3)', () => {
  const soap = (extra = {}) => ({ type: 'requestReplySoap', name: 'RR', url: 'http://s4dummy:8000/sap/bc/srt/x', authType: 'Basic', credentialName: 'CRED', proxyType: 'On-Premise', ...extra })
  const mail = (extra = {}) => ({ type: 'sendMail', name: 'SND', server: 'smtp.example.com:587', credentialName: 'CRED', from: 'a@example.com', to: 'b@example.com, c@example.com', subject: 'Hi', ...extra })
  const issues = (spec) => validate(spec).issues

  test('valid without warnings, on the main line, in routes and in local processes', () => {
    const router = { type: 'router', name: 'R', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1', steps: [soap({ name: 'S2' }), mail({ name: 'M2' })] }, { name: 'D', default: true }] }
    const spec = baseSpec({ steps: [soap(), mail(), router, { type: 'processCall', process: 'L' }], localProcesses: [{ name: 'L', steps: [soap({ name: 'S3' }), mail({ name: 'M3' })] }] })
    expect(validate(spec)).toMatchObject({ valid: true, warnings: [] })
  })

  test('only the values of the references: Basic, On-Premise', () => {
    expectError(baseSpec({ steps: [soap({ authType: 'None' })] }), /steps\[0\]\.authType: must be one of Basic/)
    expectError(baseSpec({ steps: [soap({ proxyType: 'Internet' })] }), /steps\[0\]\.proxyType: must be one of On-Premise/)
  })

  test('parameters: on SOAP only the url; on Mail the server, credential name and recipients', () => {
    expect(validate(baseSpec({ steps: [soap({ url: '{{U}}' })], parameters: { U: 'http://x/y' } })).valid).toBe(true)
    expect(issues(baseSpec({ steps: [soap({ credentialName: '{{C}}' })], parameters: { C: 'x' } }))).toEqual([{ code: 'PARAM_NOT_URL', message: 'steps[0].credentialName: on a SOAP receiver only the url can be a parameter — give the name itself' }])
    expect(validate(baseSpec({ steps: [mail({ server: '{{S}}', credentialName: '{{C}}', to: '{{T}}' })], parameters: { S: 'h:25', C: 'x', T: 'a@example.com' } })).valid).toBe(true)
    expectError(baseSpec({ steps: [mail({ server: '{{S}}' })] }), /steps\[0\]\.server: parameter 'S' is referenced but not defined/)
    expectError(baseSpec({ steps: [mail({ subject: '{{S}}' })], parameters: { S: 'x' } }), /steps\[0\]\.subject: parameters/)
  })

  test('mail fields: host:port and addresses; no secrets', () => {
    expectError(baseSpec({ steps: [mail({ server: 'smtp.example.com' })] }), /steps\[0\]\.server: invalid value — use host:port/)
    expectError(baseSpec({ steps: [mail({ to: 'not-an-address' })] }), /steps\[0\]\.to: invalid value — use mail addresses/)
    expectError(baseSpec({ steps: [mail({ from: 'a@example.com, b@example.com' })] }), /steps\[0\]\.from: invalid value — use one mail address/)
    expect(issues(baseSpec({ steps: [mail({ password: 'x' })] })).map((i) => i.code)).toEqual(['SECRET'])
    expect(issues(baseSpec({ steps: [soap({ password: 'x' })] })).map((i) => i.code)).toEqual(['SECRET'])
    expect(issues(baseSpec({ steps: [soap({ url: 'http://u:p@s4dummy/x' })] })).map((i) => i.code)).toEqual(['URL_CREDENTIALS'])
  })

  test('the exception subprocess takes a mail, not a SOAP call; SOAP and Mail are no end', () => {
    expect(validate(baseSpec({ steps: [mail()], exceptionSubprocess: { steps: [mail({ name: 'Alert' })], end: { event: 'escalation' } } })).valid).toBe(true)
    expectError(baseSpec({ steps: [mail()], exceptionSubprocess: { steps: [soap()] } }), /exceptionSubprocess\.steps\[0\]: 'requestReplySoap' is not supported in the exception subprocess/)
    expectError(baseSpec({ end: { type: 'mail' } }), /end: 'mail' is not supported/)
  })

  test('default names and receivers count with the others; other names point to the format', () => {
    const names = effectiveNames(baseSpec({ steps: [{ type: 'requestReplyHttp', url: 'https://a.example.com', method: 'GET', authType: 'None' }, soap({ name: undefined }), mail({ name: undefined })], exceptionSubprocess: { steps: [mail({ name: undefined })] } }))
    expect(names.flat.map((x) => [x.name, x.system])).toEqual([['Request Reply 1', 'Receiver1'], ['Request Reply 2', 'Receiver2'], ['Send 1', 'Receiver3']])
    expect([names.exceptionSteps, names.exceptionSystems]).toEqual([['Send 2'], ['Receiver4']])
    expectError(baseSpec({ steps: [{ type: 'soapCall' }] }), /'soapCall' — a SOAP call is \{ "type": "requestReplySoap"/)
    expectError(baseSpec({ steps: [{ type: 'email' }] }), /'email' — a mail is \{ "type": "sendMail"/)
  })
})

describe('gather: Combine or Combine at XPath', () => {
  const split = { type: 'splitter', name: 'S', kind: 'iterating', expression: '//item', stopOnException: false }
  test('only a name is Combine; source and target are Combine at XPath; one without the other is refused', () => {
    expect(validate(baseSpec({ steps: [split, { type: 'gather', name: 'G' }] }))).toMatchObject({ valid: true, warnings: [] })
    expect(validate(baseSpec({ steps: [split, { type: 'gather', name: 'G', source: '//item', target: '/items' }] }))).toMatchObject({ valid: true, warnings: [] })
    expect(validate(baseSpec({ steps: [split, { type: 'gather', name: 'G', source: '//item' }] })).issues).toEqual([
      { code: 'GATHER_XPATH', message: 'steps[1]: Combine at XPath needs both source and target — set both, or remove them for Combine' }
    ])
  })
})
