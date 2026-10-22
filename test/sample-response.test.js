/**
 * Design-time sample of a public GET endpoint (Test 3, item 9): the structure of one response, and a
 * guard so the server only fetches public endpoints.
 */
const http = require('http')
const { sampleResponse, checkUrl, isPublicAddress, pinnedGet, jsonShape } = require('../srv/lib/sample-response')

const NORTHWIND = 'https://services.odata.org/V2/Northwind/Northwind.svc/Products?$format=json&$top=2'
const publicLookup = async () => [{ address: '20.42.65.92' }]
const body = (text, contentType = 'application/json') => async () => ({ status: 200, contentType, text, truncated: false })

describe('getSampleResponse', () => {
  test('an OData V2 response gives its structure: d.results, decimals as strings', async () => {
    const json = JSON.stringify({ d: { results: [{ ProductID: 1, ProductName: 'Chai', UnitPrice: '18.0000', Discontinued: false, Category: null }, { ProductID: 2 }] } })
    const r = await sampleResponse(NORTHWIND, { get: body(json), lookup: publicLookup })
    expect(r).toMatchObject({ status: 200, format: 'json', truncated: false })
    expect(r.structure).toEqual({ d: { results: { 'array(2)': { ProductID: 'number: 1', ProductName: 'string: "Chai"', UnitPrice: 'string: "18.0000"', Discontinued: 'boolean: false', Category: 'null' } } } })
  })

  test('XML gives its element tree', async () => {
    const xml = '<feed><entry><title>Chai</title></entry><entry><title>Chang</title></entry></feed>'
    const r = await sampleResponse('https://example.org/feed', { get: body(xml, 'application/xml'), lookup: publicLookup })
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
    const redirect = async () => ({ status: 302, contentType: '', text: '', truncated: false })
    await expect(sampleResponse('https://example.org/x', { get: redirect, lookup: publicLookup })).rejects.toMatchObject({ code: 'SAMPLE_REDIRECT' })
  })

  test('IPv6 forms that carry an internal IPv4 address are refused (review: ::ffff:a9fe:a9fe passed)', async () => {
    for (const ip of ['::ffff:a9fe:a9fe', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001', '::ffff:169.254.169.254', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', 'fe80::1%eth0', 'zz::1'])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false])
    for (const ip of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2606:4700::1111']) expect([ip, isPublicAddress(ip)]).toEqual([ip, true])
    await expect(checkUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data/')).rejects.toMatchObject({ code: 'SAMPLE_NOT_PUBLIC' })
    await expect(checkUrl('http://2130706433/')).rejects.toMatchObject({ code: 'SAMPLE_NOT_PUBLIC' }) // decimal 127.0.0.1
  })

  test('the connection uses the checked address, never a second DNS lookup (DNS rebinding)', async () => {
    const server = http.createServer((req, res) => res.end(JSON.stringify({ host: req.headers.host })))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      // a host name that does not resolve: the request can only succeed through the pinned address
      const url = new URL(`http://pinned.invalid:${server.address().port}/x`)
      const r = await pinnedGet(url, { address: '127.0.0.1', family: 4 })
      expect(r).toMatchObject({ status: 200, truncated: false })
      expect(JSON.parse(r.text)).toEqual({ host: `pinned.invalid:${server.address().port}` }) // the name stays in the Host header
    } finally {
      server.close()
    }
  })

  test('sampleResponse passes the checked address to the request', async () => {
    let seen
    const get = async (url, target) => ((seen = { host: url.hostname, ...target }), { status: 200, contentType: 'application/json', text: '{}', truncated: false })
    await sampleResponse('https://api.example.org/x', { get, lookup: async () => [{ address: '20.42.65.92' }] })
    expect(seen).toEqual({ host: 'api.example.org', address: '20.42.65.92', family: 4 })
  })
})

