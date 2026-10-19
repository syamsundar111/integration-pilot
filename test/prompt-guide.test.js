/**
 * docs/prompt-guide.md: the SF -> Directory worked example is a test case. The improved request
 * passes the prompt linter with the session defaults, the expected spec validates and builds
 * with the attached scripts, and importing the built iFlow gives the same spec back.
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
const FIXTURE = 'test/fixtures/sf-entra'
const spec = JSON.parse(read(`${FIXTURE}/spec.json`))
const attachments = { 'mapSfToEntra.groovy': read(`${FIXTURE}/mapSfToEntra.groovy`), 'buildErrorNotification.groovy': read(`${FIXTURE}/buildErrorNotification.groovy`) }
const defaults = { packageId: spec.packageId, timer: 'once', authNote: 'OAuth2 SAML Bearer Assertion with credential DEMO_OAUTH on RCVR_SF_User and RCVR_SF_AccountLockOut' }

function loadUi5Module(file) {
  let exported
  global.sap = { ui: { define: (_deps, factory) => (exported = factory()) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return exported
}
const { lint } = loadUi5Module(path.join(ROOT, 'app/integration-pilot/webapp/util/promptLint.js'))

/** The code block after <!-- example:<name> --> */
const example = (name) => GUIDE.split(`<!-- example:${name} -->`)[1].split('```text\n')[1].split('```')[0]

const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'description' ? undefined : v)))
const sortParams = (s) => ({ ...s, parameters: Object.fromEntries(Object.entries(s.parameters).sort()) })

describe('prompt guide: SF -> Directory worked example', () => {
  test('the original request lacks package and authentication; the improved one passes with the defaults', () => {
    expect(lint(read('scripts/measure/sf-entra-request.md')).map((w) => w.key)).toEqual(['package', 'auth'])
    expect(lint(example('improved-request'), { defaults })).toEqual([])
  })

  test('the measurement script sends the same improved request', () => {
    expect(read('scripts/measure/sf-entra-improved-request.md')).toBe(example('improved-request'))
  })

  test('the improved request keeps the values of the original', () => {
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
    expect(await zip.file('src/main/resources/script/mapSfToEntra.groovy').async('string')).toBe(attachments['mapSfToEntra.groovy'])
  })

  test('importing the built iFlow gives the same spec and scripts back', async () => {
    const { zipBase64 } = await build(spec, { attachments })
    const r = await importIflow(Buffer.from(zipBase64, 'base64'), { fileName: 'sf-entra.zip', packageId: spec.packageId })
    expect(r).toMatchObject({ valid: true, placeholders: 0, notes: [] })
    // descriptions are not part of the iFlow
    expect(sortParams(strip(r.spec))).toEqual(sortParams(strip(spec)))
    expect(r.attachments).toEqual(attachments)
  })

  test('the SourceSystem -> S/4HANA example is the measured request, passes the check and has 25 steps', () => {
    const request = example('SourceSystem-s4-request')
    expect(read('scripts/measure/SourceSystem-s4-request.md')).toBe(request)
    expect(lint(request)).toEqual([])
    const { estimateSteps } = loadUi5Module(path.join(ROOT, 'app/integration-pilot/webapp/util/promptLint.js'))
    expect(estimateSteps(request)).toBe(25)
  })
})
