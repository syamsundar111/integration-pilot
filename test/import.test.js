/**
 * Import of any iFlow into a draft spec (srv/iflow-builder/import.js). Unsupported content is
 * produced by building an iFlow and patching its .iflw the way CPI would write it.
 */
const JSZip = require('jszip')
const { build } = require('../srv/iflow-builder/builder')
const { importIflow } = require('../srv/iflow-builder/import')
const { validate } = require('../srv/iflow-builder/validator')
const { baseSpec } = require('./helpers')

const IFLW = /src\/main\/resources\/scenarioflows\/integrationflow\/[^/]+\.iflw$/

/** Builds the spec and applies `patch` to the .iflw text; returns the zip as a Buffer */
async function zipWith(spec, patch = (x) => x, { attachments } = {}) {
  const { zipBase64 } = await build(spec, { attachments })
  const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
  const path = Object.keys(zip.files).find((f) => IFLW.test(f))
  zip.file(path, patch(await zip.file(path).async('string')))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** Sets the activityType of the steps whose names match `names` */
const retype = (iflw, names, activityType) =>
  iflw.replace(/(<bpmn2:callActivity id="[^"]+" name="([^"]+)">[\s\S]*?<key>activityType<\/key>\s*<value>)[A-Za-z]+(<\/value>)/g, (m, head, name, tail) =>
    names.includes(name) ? `${head}${activityType}${tail}` : m
  )
const rename = (iflw, from, to) => iflw.replace(`name="${from}"`, `name="${to}"`)
/** Encoded Content Modifier row: Type cell of the row whose Value is `value` */
const rowType = (iflw, value, type) => iflw.replace(`&lt;cell id='Type'&gt;constant&lt;/cell&gt;&lt;cell id='Value'&gt;${value}&lt;`, `&lt;cell id='Type'&gt;${type}&lt;/cell&gt;&lt;cell id='Value'&gt;${value}&lt;`)

const converters = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ type: 'jsonToXml', name: `S${from + i}` }))

describe('import', () => {
  test('unsupported steps become placeholders, merged to stay within 50 steps; XPath moves into Groovy', async () => {
    const spec = baseSpec({
      steps: [
        { type: 'contentModifier', name: 'Values', properties: [{ name: 'OrderId', type: 'constant', value: '/Order/Id' }, { name: 'Source', type: 'constant', value: 'Shop' }] },
        ...converters(49)
      ],
      end: { type: 'httpReceiver', system: 'Backend', url: 'https://example.org/orders', method: 'POST', authType: 'None' }
    })
    const zip = await zipWith(spec, (x) =>
      rename(rename(rowType(retype(x, ['S3', 'S4', 'S5', 'S6', 'S7', 'S8'], 'Splitter'), '/Order/Id', 'xpath'), 'S10', 'Dup'), 'S11', 'Dup').replace(
        /(<key>authenticationMethod<\/key>\s*)<value>None<\/value>/,
        '$1<value>OAuth2SAMLBearerAssertion</value>'
      )
    )
    const r = await importIflow(zip, { fileName: 'orders.zip', packageId: 'PilotReference' })
    expect(r).toMatchObject({ valid: true, errors: [], placeholders: 1 })
    const names = r.spec.steps.map((s) => s.name)

    // 1 Groovy + 1 Content Modifier + 49 converters = 51 > 50: the 6 splitters became one placeholder
    expect(r.spec.steps).toHaveLength(46)
    const merged = r.spec.steps.find((s) => /^REPLACE WITH /.test(s.description || ''))
    expect(merged).toMatchObject({ type: 'contentModifier', name: 'S3', properties: [{ name: 'REPLACE_WITH', type: 'constant' }] })
    expect(merged.description).toBe("REPLACE WITH Splitter 'S3'; then Splitter 'S4'; then Splitter 'S5'; then Splitter 'S6'; then Splitter 'S7'; then Splitter 'S8'")
    expect(r.notes).toContain('Main flow: 6 consecutive placeholders were merged into one to stay within 50 steps')

    // XPath: a generated script before the Content Modifier, which keeps its constant
    expect(r.spec.steps.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'groovyScript', name: 'Values XPath', fileName: 'xpath_Values' }),
      expect.objectContaining({ type: 'contentModifier', name: 'Values', properties: [{ name: 'Source', type: 'constant', value: 'Shop' }] })
    ])
    expect(r.attachments['xpath_Values.groovy']).toContain("message.setProperty('OrderId', xpath.evaluate('/Order/Id', doc))")

    // unique names, authentication reset to None with a note
    expect(names.filter((n) => n.startsWith('Dup'))).toEqual(['Dup', 'Dup 2'])
    expect(new Set(names).size).toBe(names.length)
    expect(r.spec.end).toMatchObject({ type: 'httpReceiver', system: 'Backend', authType: 'None' })
    expect(r.notes.join('\n')).toMatch(/End receiver Backend: set authentication OAuth2SAMLBearerAssertion/)

    // the generated script is a valid Groovy step for the builder
    const { zipBase64 } = await build(r.spec, { attachments: r.attachments })
    expect(zipBase64).toBeTruthy()
  })

  test('too many real steps are refused with a hint', async () => {
    const spec = baseSpec({
      steps: [{ type: 'contentModifier', name: 'Values', properties: [{ name: 'A', type: 'constant', value: '/a' }, { name: 'B', type: 'constant', value: 'b' }] }, ...converters(49)]
    })
    const zip = await zipWith(spec, (x) => rowType(x, '/a', 'xpath'))
    await expect(importIflow(zip, { fileName: 'big.zip' })).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', status: 400 })
  })

  test('a bare .iflw: id from the file name, missing scripts become placeholders', async () => {
    const { GROOVY } = require('./helpers')
    const spec = baseSpec({ steps: [{ type: 'groovyScript', name: 'Script', fileName: 'doIt', code: GROOVY }] })
    const { files } = await build(spec)
    const iflw = files.find((f) => IFLW.test(f.path)).content
    const r = await importIflow(Buffer.from(iflw), { fileName: 'My Flow.iflw' })
    expect(r.spec).toMatchObject({ id: 'My_Flow', packageId: 'Imported', trigger: { type: 'httpsSender', address: '/test/flow' } })
    expect(r.spec.steps[0].description).toMatch(/^REPLACE WITH Groovy script 'Script' \(doIt.groovy is missing in the export\)/)
    expect(r.notes).toContain('Target package: set one before proposing (session defaults or the proposal panel)')
    expect(validate(r.spec, { attachments: Object.keys(r.attachments) }).valid).toBe(true)
  })
})
