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

  test('receiver auth is None only; authentication is set in the CPI web editor', () => {
    const end = (e) => baseSpec({ end: { type: 'httpReceiver', url: 'https://x.org', method: 'POST', ...e } })
    expect(errorsOf(end({ authType: 'None' }))).toEqual([])
    for (const authType of ['Basic', 'OAuth2ClientCredentials']) {
      const errors = errorsOf(end({ authType }))
      expect(errors).toEqual([
        `end.authType: '${authType}' is not supported in v1 — create the receiver with authType None, then set authentication and credentials in the CPI web editor after creation`
      ])
    }
    const rr = baseSpec({ steps: [{ type: 'requestReplyHttp', url: 'https://x.org', method: 'GET', authType: 'None', credentialAlias: 'A' }] })
    expect(errorsOf(rr)).toEqual([expect.stringMatching(/^steps\[0\]: credentialAlias is not supported in v1 — create the receiver with authType None/)])
    expectError(end({ authType: 'None', url: 'https://user:secret@x.org/api' }), /end\.url: contains user:password/)
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
    expectError(wrongPlace, /steps\[0\]\.headers\[0\]\.value: parameters .* can only be used as an HTTP receiver url/)

    const senderParam = baseSpec({ trigger: { type: 'httpsSender', address: '{{Path}}' }, parameters: { Path: '/x' } })
    expectError(senderParam, /trigger\.address: parameters .* can only be used as an HTTP receiver url in v1/)
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
        ...Array.from({ length: 24 }, () => ({ type: 'jsonToXml' }))
      ],
      end: { type: 'httpReceiver', url: '{{Missing}}', method: 'POST', authType: 'Basic' }
    })
    const { issues, errors } = validate(spec)
    expect(issues.map((i) => i.message)).toEqual(errors)
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(['STEP_NOT_IN_V1', 'AUTH_UNSUPPORTED', 'BAD_VALUE', 'TOO_MANY', 'DUPLICATE_STEP_NAME', 'PARAM_UNDEFINED']))
  })
})
