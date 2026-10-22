/**
 * Design-time sample of a public GET endpoint (Test 3, item 9): the structure of one response, and a
 * guard so the server only fetches public endpoints.
 */
const { sampleResponse, checkUrl, isPublicAddress, jsonShape } = require('../srv/lib/sample-response')

const NORTHWIND = 'https://services.odata.org/V2/Northwind/Northwind.svc/Products?$format=json&$top=2'
const publicLookup = async () => [{ address: '20.42.65.92' }]
const body = (text, contentType = 'application/json') => async () => new Response(text, { status: 200, headers: { 'content-type': contentType } })

describe('getSampleResponse', () => {
  test('an OData V2 response gives its structure: d.results, decimals as strings', async () => {
    const json = JSON.stringify({ d: { results: [{ ProductID: 1, ProductName: 'Chai', UnitPrice: '18.0000', Discontinued: false, Category: null }, { ProductID: 2 }] } })
    const r = await sampleResponse(NORTHWIND, { fetchImpl: body(json), lookup: publicLookup })
    expect(r).toMatchObject({ status: 200, format: 'json', truncated: false })
    expect(r.structure).toEqual({ d: { results: { 'array(2)': { ProductID: 'number: 1', ProductName: 'string: "Chai"', UnitPrice: 'string: "18.0000"', Discontinued: 'boolean: false', Category: 'null' } } } })
  })

  test('XML gives its element tree', async () => {
    const xml = '<feed><entry><title>Chai</title></entry><entry><title>Chang</title></entry></feed>'
    const r = await sampleResponse('https://example.org/feed', { fetchImpl: body(xml, 'application/xml'), lookup: publicLookup })
    expect(r).toMatchObject({ format: 'xml', structure: { feed: { 'entry (×2)': { title: 'text: "Chai"' } } } })
  })

  test('long values and many keys are truncated', () => {
    const many = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`k${i}`, 'x'.repeat(60)]))
    const s = jsonShape(many)
    expect(Object.keys(s)).toHaveLength(31)
    expect(s.k0).toBe(`string: "${'x'.repeat(36)}…`) // the cut keeps 37 characters of the JSON, quote included
    expect(s['…']).toBe('5 more keys')
  })

  test('only public endpoints: private, loopback, metadata and placeholder URLs are refused', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPublicAddress(ip)).toBe(false)
    for (const ip of ['20.42.65.92', '8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(ip)).toBe(true)
    await expect(checkUrl('http://localhost:4005/api', { lookup: async () => [{ address: '127.0.0.1' }] })).rejects.toMatchObject({ code: 'SAMPLE_NOT_PUBLIC' })
    await expect(checkUrl('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ code: 'SAMPLE_NOT_PUBLIC' })
    await expect(checkUrl('https://user:pw@example.org/x')).rejects.toMatchObject({ code: 'SAMPLE_BAD_URL' })
    await expect(checkUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'SAMPLE_BAD_URL' })
    await expect(checkUrl('https://<tenant>-rt.example.com/http/x')).rejects.toMatchObject({ code: 'SAMPLE_BAD_URL' })
    await expect(checkUrl('{{Products_URL}}')).rejects.toMatchObject({ code: 'SAMPLE_BAD_URL' })
  })

  test('redirects are not followed', async () => {
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
    await expect(sampleResponse('https://example.org/x', { fetchImpl: redirect, lookup: publicLookup })).rejects.toMatchObject({ code: 'SAMPLE_REDIRECT' })
  })
})
