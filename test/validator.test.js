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

  test.each(['router', 'splitter', 'messageMapping', 'contentBasedRouter'])('rejects %s with a clear v1 message', (type) => {
    expectError(baseSpec({ steps: [{ type }] }), new RegExp(`steps\\[0\\]: '${type}' is not supported in v1 — flows must be linear`))
  })

  test('rejects unknown step, trigger and end types', () => {
    const errors = errorsOf(baseSpec({ steps: [{ type: 'magic' }], trigger: { type: 'sftp' }, end: { type: 'mail' } })).join('\n')
    expect(errors).toMatch(/steps\[0\]: unknown step type 'magic'/)
    expect(errors).toMatch(/trigger: 'sftp' is not supported in v1/)
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
          "end: proxyType 'sapcc' is seen in only one reference export (A) and not yet confirmed in the CPI editor",
          "end: authenticationMethod 'Basic' is seen in only one reference export (A) and not yet confirmed in the CPI editor"
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

    const wrongPlace = baseSpec({ steps: [{ type: 'contentModifier', headers: [{ name: 'X', type: 'constant', value: '{{P}}' }] }], parameters: { P: 'v' } })
    expectError(wrongPlace, /steps\[0\]\.headers\[0\]\.value: parameters .* can only be used as the whole url, credentialName or locationId of an HTTP receiver/)

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
        { type: 'contentModifier', name: 'A', headers: [{ name: 'X', type: 'xpath', value: '/a' }] },
        { type: 'router' },
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
    const inValue = baseSpec({ steps: [{ type: 'contentModifier', name: 'Note', headers: [{ name: 'X', type: 'constant', value: '{{Scheduler}}' }] }] })
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
      `steps: step name 'Script_SetCustomHeaders_Exc' is used more than once, at exceptionSubprocess.steps[1] and exceptionSubprocess.steps[2] — step names must be unique (main flow and exception subprocess together); ${fix}`,
      `steps: Groovy fileName 'Script_SetCustomHeaders_Exc' is used more than once, at exceptionSubprocess.steps[1] and exceptionSubprocess.steps[2] — each script needs its own file; ${fix}`
    ])
  })

  test('different steps with one name: rename or remove', () => {
    const r = validate(baseSpec({ steps: [{ type: 'jsonToXml', name: 'Convert' }, { type: 'xmlToJson', name: 'Convert' }] }))
    expect(r.errors).toEqual([
      `steps: step name 'Convert' is used more than once, at steps[0] and steps[1] — step names must be unique (main flow and exception subprocess together); rename all but one, or remove the extra step (editDraftSpec {"op":"removeStep","index":1})`
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
