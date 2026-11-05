/**
 * docs/prompt-guide.md: the worked examples are test cases. The small flow's improved request passes
 * the prompt linter, its expected spec validates and builds with the
 * attached scripts, and importing the built iFlow gives the same spec back. The larger examples pass
 * the linter and match the measurement requests.
 */
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const { validate } = require('../srv/iflow-builder/validator')
const { build } = require('../srv/iflow-builder/builder')
const { importIflow } = require('../srv/iflow-builder/import')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const GUIDE = read('docs/prompt-guide.md')
const FIXTURE = 'test/fixtures/users-summary'
const spec = JSON.parse(read(`${FIXTURE}/spec.json`))
const attachments = { 'summarizeUsers.groovy': read(`${FIXTURE}/summarizeUsers.groovy`), 'buildErrorMessage.groovy': read(`${FIXTURE}/buildErrorMessage.groovy`) }

function loadUi5Module(file) {
  let exported
  global.sap = { ui: { define: (_deps, factory) => (exported = factory()) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return exported
}
const { lint, estimateSteps } = loadUi5Module(path.join(ROOT, 'app/integration-pilot/webapp/util/promptLint.js'))

/** The code block after <!-- example:<name> --> */
const example = (name) => GUIDE.split(`<!-- example:${name} -->`)[1].split('```text\n')[1].split('```')[0]

const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'description' ? undefined : v)))
const sortParams = (s) => ({ ...s, parameters: Object.fromEntries(Object.entries(s.parameters).sort()) })

describe('the pre-send check passes every example request (a warning on our own examples is a bug)', () => {
  const names = [...GUIDE.matchAll(/<!-- example:([\w-]+) -->/g)].map((m) => m[1])

  test.each(names)('prompt guide example %s', (name) => {
    expect(lint(example(name))).toEqual([])
  })

  test('the step c tenant-check request: a parameter right after the HTTP method is the whole URL', () => {
    const request = [
      'Create an iFlow "Builder V2 HTTP Check 2" in package iglow. Trigger: timer, run once.',
      '1. Request Reply "RR_Basic_Internet" to receiver RCV_Basic_Internet: GET {{BasicInternetAddress}},',
      '   default https://basic.example.com/api/items, authentication Basic, credential DUMMY_BASIC_CRED.',
      '2. Request Reply "RR_Basic_OnPrem" to receiver RCV_Basic_OnPrem: POST http://s4dummy:8000/sap/bc/dummy,',
      '   proxy On-Premise, location ID DUMMY_LOC, authentication Basic, credential DUMMY_ONPREM_CRED, timeout 30000 ms.',
      'End: none.'
    ].join('\n')
    expect(lint(request)).toEqual([])
    expect(lint('Create an iFlow: POST to {{OrderReceiver}}\nthen a call to address {{Second}}')).toEqual([])
  })

  test('on a URL line too: a parameter after user or password, or inside a URL, is flagged', () => {
    const flagged = (t) => lint(t).flatMap((w) => (w.key === 'params' ? [w.message.split(':')[0]] : []))
    expect(flagged('Create an iFlow: GET https://x.example.com/api with user {{User}} and password: {{Pwd}}')).toEqual(['{{User}}, {{Pwd}}'])
    expect(flagged('Create an iFlow: GET https://{{Host}}/api')).toEqual(['{{Host}}'])
    expect(flagged('Create an iFlow: GET https://x.example.com/{{Path}}')).toEqual(['{{Path}}'])
    expect(flagged('Create an iFlow: GET {{Base}}/orders, url of the shop')).toEqual(['{{Base}}'])
    // a whole URL stays fine
    expect(flagged('Create an iFlow: GET {{ShopURL}}, default https://x.example.com/api')).toEqual([])
  })

  test('a credential name or location ID may be a parameter (step c2); elsewhere a parameter is flagged', () => {
    const flagged = (t) => lint(t).flatMap((w) => (w.key === 'params' ? [w.message.split(':')[0]] : []))
    expect(flagged('Create an iFlow: POST https://x.example.com/api, credential {{ErpCredential}}, proxy On-Premise, location ID {{ErpLocation}}')).toEqual([])
    expect(flagged('Create an iFlow: GET {{Orders}}, Basic, credential name: {{ErpCredential}}')).toEqual([])
    expect(lint('Create an iFlow: GET {{Orders}}, header Source = {{Source}}').map((w) => w.message)).toEqual([
      '{{Source}}: parameters work only as the whole URL, credential name or location ID of an HTTP or OData receiver, the URL of a SOAP receiver, the server, credential name or recipients of a mail, the host, directory, file name, credential name or archive directory of an SFTP sender, the host, directory, file name or credential name of an SFTP receiver, or as a constant value. Use literal values elsewhere.'
    ])
  })
})

describe('prompt guide: small flow (Users Summary)', () => {
  test('both requests pass the pre-send check (package, trigger and authentication get defaults)', () => {
    expect(lint(read('scripts/measure/users-summary-request.md'))).toEqual([])
    expect(lint(example('improved-request'))).toEqual([])
  })

  test('the measurement script sends the same improved request', () => {
    expect(read('scripts/measure/users-summary-improved-request.md')).toBe(example('improved-request'))
  })

  test('the improved request keeps the values of the first request', () => {
    const improved = example('improved-request')
    for (const p of spec.steps[0].properties) expect(improved).toContain(`${p.name} = ${p.value}`)
    for (const url of Object.values(spec.parameters)) expect(improved).toContain(url)
    for (const s of [...spec.steps, ...spec.exceptionSubprocess.steps]) expect(improved).toContain(`"${s.name}"`)
  })

  test('the expected spec validates and builds with the attached scripts', async () => {
    expect(validate(spec, { attachments: Object.keys(attachments) })).toMatchObject({ valid: true })
    expect(validate(spec).issues.map((i) => i.code)).toEqual(['ATTACHMENT_MISSING', 'ATTACHMENT_MISSING'])
    const { zipBase64 } = await build(spec, { attachments })
    const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
    expect(await zip.file('src/main/resources/script/summarizeUsers.groovy').async('string')).toBe(attachments['summarizeUsers.groovy'])
  })

  test('importing the built iFlow gives the same spec and scripts back', async () => {
    const { zipBase64 } = await build(spec, { attachments })
    const r = await importIflow(Buffer.from(zipBase64, 'base64'), { fileName: 'users-summary.zip', packageId: spec.packageId })
    // iFlow ids are unique per tenant: the import gets a new id, and that is the only note
    expect(r).toMatchObject({ valid: true, placeholders: 0, notes: [expect.stringMatching(new RegExp(`^iFlow id: ${spec.id}_Imported, a new id`))] })
    // descriptions are not part of the iFlow
    expect(sortParams(strip(r.spec))).toEqual(sortParams(strip({ ...spec, id: `${spec.id}_Imported` })))
    expect(r.attachments).toEqual(attachments)
  })
})

describe('prompt guide: larger examples', () => {
  test('the orchestration passes the check: 13 steps, calls to the test API, a POST to httpbin', () => {
    const request = example('orchestration-request')
    expect(lint(request)).toEqual([])
    expect(estimateSteps(request)).toBe(13)
    expect(request).toContain('https://jsonplaceholder.typicode.com/')
    expect(request).toContain('default https://httpbin.org/post')
  })

  test('the placeholder rebuild is the measured request: 25 steps, 8 placeholders, generic systems', () => {
    const request = example('placeholder-rebuild-request')
    expect(read('scripts/measure/placeholder-rebuild-request.md')).toBe(request)
    expect(lint(request)).toEqual([])
    expect(estimateSteps(request)).toBe(25)
    expect(request.match(/^\d+\. PH "PH_[^"]+"/gm).map((l) => l.match(/"(PH_[^"]+)"/)[1])).toEqual([
      'PH_Router_HasRecords',
      'PH_Splitter_Records',
      'PH_Router_Validation',
      'PH_Mapping_Source_to_ERP',
      'PH_Router_MappingCheck_RR_TargetERP',
      'PH_Router_ERPResult_PayloadLogging',
      'PH_Router_RecordFound',
      'PH_WV_LastRunTime'
    ])
    // every host is an example host
    for (const host of request.match(/https?:\/\/[^/\s"]+/g)) expect(host).toMatch(/^https?:\/\/[a-z.-]*example\.com$/)
  })
})
