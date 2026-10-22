/**
 * Receiver URLs with a query (Test 3, Northwind): CPI keeps the query in the receiver's Query field
 * (httpAddressQuery) and the address without it (httpAddressWithoutQuery), as in client exports.
 * The whole URL in Address with an empty Query showed as an error in the CPI editor.
 */
const JSZip = require('jszip')
const { build, splitParameters } = require('../srv/iflow-builder/builder')
const { validate } = require('../srv/iflow-builder/validator')
const { parse } = require('../srv/iflow-builder/parser')
const { specFromParsed } = require('../srv/iflow-builder/to-spec')
const { importIflow } = require('../srv/iflow-builder/import')
const { baseSpec } = require('./helpers')

const NORTHWIND = 'https://services.odata.org/V2/Northwind/Northwind.svc/Products?$format=json&$top=20'
const BASE = 'https://services.odata.org/V2/Northwind/Northwind.svc/Products'
const QUERY = '$format=json&$top=20'

const withParam = baseSpec({
  id: 'Northwind_Query',
  steps: [{ type: 'requestReplyHttp', name: 'GetProducts', system: 'Northwind', url: '{{Products_URL}}', method: 'GET', authType: 'None' }],
  parameters: { Products_URL: NORTHWIND }
})
const literal = baseSpec({ id: 'Northwind_Literal', steps: [{ type: 'requestReplyHttp', name: 'GetProducts', system: 'Northwind', url: NORTHWIND, method: 'GET', authType: 'None' }] })

async function files(spec) {
  const zip = await JSZip.loadAsync(Buffer.from((await build(spec)).zipBase64, 'base64'))
  const iflw = await zip.file(/\.iflw$/)[0].async('string')
  const prop = await zip.file('src/main/resources/parameters.prop').async('string')
  const value = (key) => iflw.match(new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`))?.[1]?.replace(/&amp;/g, '&') // XML-escaped in the .iflw
  return { zipBase64: (await build(spec)).zipBase64, value, prop }
}

describe('receiver URL with a query', () => {
  test('a parameter URL: Address is the parameter, Query gets the query, the default is the base URL', async () => {
    const { value, prop } = await files(withParam)
    expect(value('httpAddressWithoutQuery')).toBe('{{Products_URL}}')
    expect(value('httpAddressQuery')).toBe(QUERY)
    expect(prop).toContain(`Products_URL=${BASE.replace(/:/g, '\\:')}\n`)
    expect(prop).not.toContain('$format')
    expect(splitParameters(withParam.parameters)).toEqual({ params: { Products_URL: BASE }, queries: { Products_URL: QUERY } })
  })

  test('a literal URL is split the same way', async () => {
    const { value } = await files(literal)
    expect(value('httpAddressWithoutQuery')).toBe(BASE)
    expect(value('httpAddressQuery')).toBe(QUERY)
  })

  test('the validator says where the query goes', () => {
    const r = validate(withParam)
    expect(r.valid).toBe(true)
    expect(r.warnings).toEqual([`steps[0].url: the query "${QUERY}" is written to the receiver's Query field, not the Address; the parameter Products_URL holds the URL before '?'`])
    expect(validate(literal).warnings).toEqual([`steps[0].url: the query "${QUERY}" is written to the receiver's Query field, not the Address`])
  })

  test('reading the iFlow back (update) gives the same spec: url {{Products_URL}}, the full URL as default', async () => {
    const { zipBase64 } = await files(withParam)
    const { spec, blockers } = specFromParsed(await parse(zipBase64), { packageId: withParam.packageId })
    expect(blockers).toEqual([])
    expect(spec.steps[0].url).toBe('{{Products_URL}}')
    expect(spec.parameters.Products_URL).toBe(NORTHWIND)
  })

  test('importing the iFlow keeps the parameter and its query', async () => {
    const { zipBase64 } = await files(withParam)
    const r = await importIflow(Buffer.from(zipBase64, 'base64'), { fileName: 'northwind.zip', packageId: 'PilotReference' })
    expect(r.spec.steps[0].url).toBe('{{Products_URL}}')
    expect(r.spec.parameters.Products_URL).toBe(NORTHWIND)
    expect(r.valid).toBe(true)
  })
})

describe('parameter handling (full review)', () => {
  test('two receivers sharing {{U}}: an update reads the query back once, not once per receiver', async () => {
    const spec = baseSpec({
      id: 'Shared_Query',
      steps: [{ type: 'requestReplyHttp', name: 'Get', system: 'S1', url: '{{U}}', method: 'GET', authType: 'None' }],
      end: { type: 'httpReceiver', system: 'S2', url: '{{U}}', method: 'POST', authType: 'None' },
      parameters: { U: 'https://h/x?$format=json' }
    })
    let current = spec
    for (let i = 0; i < 3; i++) {
      const { spec: back, blockers } = specFromParsed(await parse((await build(current)).zipBase64), { packageId: spec.packageId })
      expect(blockers).toEqual([])
      expect(back.parameters.U).toBe('https://h/x?$format=json') // stable over repeated updates
      current = back
    }
  })

  test('a parameter that no receiver uses keeps its query', async () => {
    const spec = baseSpec({ id: 'Doc_Param', parameters: { Doc: 'https://h/x?a=1' } })
    const { spec: back } = specFromParsed(await parse((await build(spec)).zipBase64), { packageId: spec.packageId })
    expect(back.parameters.Doc).toBe('https://h/x?a=1')
  })

  test('names of Object.prototype are not defined parameters', () => {
    const r = validate(baseSpec({ steps: [{ type: 'requestReplyHttp', name: 'R', system: 'S', url: '{{constructor}}', method: 'GET', authType: 'None' }] }))
    expect(r.valid).toBe(false)
    expect(r.errors).toEqual(["steps[0].url: parameter 'constructor' is referenced but not defined in 'parameters'"])
  })
})
