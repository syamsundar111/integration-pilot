/**
 * Design-time sample of a public GET endpoint: fetches one response and returns only its structure
 * (keys, types, short example values), so the model writes a script against the real data shape
 * (e.g. OData V2 {"d":{"results":[...]}} with decimals as strings) instead of guessing.
 *
 * The server fetches a URL the model chooses, so it only reaches the public internet: http(s) only,
 * no credentials in the URL, the host must resolve to public addresses only, redirects are not
 * followed, 8 s timeout, at most 256 KB read. The host is resolved once and the connection goes to
 * that checked address (no second DNS lookup, so DNS rebinding cannot swap in an internal address);
 * the host name is still used for TLS (SNI) and the Host header.
 */
const dns = require('dns').promises
const net = require('net')
const http = require('http')
const https = require('https')
const { DOMParser } = require('@xmldom/xmldom')

const TIMEOUT_MS = 8000
const MAX_BYTES = 256 * 1024
const MAX_DEPTH = 5
const MAX_KEYS = 30

/** The 8 hextets of an IPv6 address (any notation, incl. an embedded dotted IPv4 and a zone id), or null */
function hextets(ip) {
  let v6 = String(ip).toLowerCase().replace(/%.*$/, '')
  const dotted = v6.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null
    const [a, b, c, d] = dotted[2].split('.').map(Number)
    v6 = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = v6.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const all = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail]
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null
  return all.map((h) => parseInt(h, 16))
}

const v4Public = (a, b) => !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224)
const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255]

/**
 * Loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, unique-local, multicast,
 * reserved; an IPv6 address that carries an IPv4 address (IPv4-mapped ::ffff:0:0/96 in any notation,
 * IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) is judged by that IPv4 address.
 */
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return v4Public(a, b)
  }
  const h = hextets(ip)
  if (!h) return false // not an address we understand: never public
  const zeros = (n) => h.slice(0, n).every((x) => x === 0)
  if (zeros(5) && h[5] === 0xffff) return v4Public(...v4Of(h[6], h[7])) // ::ffff:a.b.c.d / ::ffff:a9fe:a9fe
  if (zeros(6)) return false // ::, ::1 and IPv4-compatible ::a.b.c.d (deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4Public(...v4Of(h[6], h[7])) // NAT64
  if (h[0] === 0x2002) return v4Public(...v4Of(h[1], h[2])) // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return false // unique-local fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((h[0] & 0xff00) === 0xff00) return false // multicast
  return true
}

const fail = (code, message) => Object.assign(new Error(message), { code })

/** Throws unless the URL may be fetched (see the module comment) */
async function checkUrl(raw, { lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw fail('SAMPLE_BAD_URL', `not a URL: ${raw}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('SAMPLE_BAD_URL', 'only http and https URLs')
  if (url.username || url.password) throw fail('SAMPLE_BAD_URL', 'no credentials in the URL')
  if (/[{}<>]/.test(decodeURIComponent(url.href))) throw fail('SAMPLE_BAD_URL', 'the URL still contains a placeholder or a {{parameter}}; pass the real URL')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => [])
  if (!addresses.length) throw fail('SAMPLE_UNREACHABLE', `host ${host} does not resolve`)
  if (!addresses.every((a) => isPublicAddress(a.address))) throw fail('SAMPLE_NOT_PUBLIC', `host ${host} is not a public address; only public endpoints are sampled`)
  // the address the connection must use: the checked one, not a second lookup
  const { address } = addresses[0]
  return { url, address, family: net.isIPv6(address) ? 6 : 4 }
}

/**
 * GET with the connection pinned to `address` (no DNS lookup of its own), no redirects, a timeout and
 * a size limit. Resolves { status, contentType, text, truncated }.
 */
function pinnedGet(url, { address, family }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json, application/xml;q=0.9, */*;q=0.5' },
        lookup: (_host, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        timeout: TIMEOUT_MS
      },
      (res) => {
        const chunks = []
        let size = 0
        let truncated = false
        res.on('data', (c) => {
          if (truncated) return
          chunks.push(c)
          size += c.length
          if (size >= MAX_BYTES) {
            truncated = true
            res.destroy()
            finish()
          }
        })
        res.on('end', () => finish())
        res.on('error', (e) => (truncated ? finish() : reject(e)))
        let done = false
        function finish() {
          if (done) return
          done = true
          resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', text: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES), truncated })
        }
      }
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

/** Structure of a JSON value: objects as { key: structure }, arrays as [structure of the first item] */
function jsonShape(v, depth = 0) {
  if (v === null) return 'null'
  if (Array.isArray(v)) {
    const first = v.find((x) => x != null)
    return { [`array(${v.length})`]: first === undefined ? 'empty' : depth >= MAX_DEPTH ? '…' : jsonShape(first, depth + 1) }
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    const out = {}
    for (const k of keys.slice(0, MAX_KEYS)) out[k] = depth >= MAX_DEPTH ? '…' : jsonShape(v[k], depth + 1)
    if (keys.length > MAX_KEYS) out['…'] = `${keys.length - MAX_KEYS} more keys`
    return out
  }
  const s = JSON.stringify(v)
  return `${typeof v}: ${s.length > 40 ? s.slice(0, 37) + '…' : s}`
}

/** Element tree of an XML document: { tag: { childTag: ... } }, repeated children counted */
function xmlShape(el, depth = 0) {
  const kids = [...(el.childNodes || [])].filter((n) => n.nodeType === 1)
  if (!kids.length) {
    const t = (el.textContent || '').trim()
    return t ? `text: ${JSON.stringify(t.length > 40 ? t.slice(0, 37) + '…' : t)}` : 'empty'
  }
  const out = {}
  for (const k of kids) {
    const n = kids.filter((x) => x.nodeName === k.nodeName).length
    const key = n > 1 ? `${k.nodeName} (×${n})` : k.nodeName
    if (!(key in out)) out[key] = depth >= MAX_DEPTH ? '…' : xmlShape(k, depth + 1)
    if (Object.keys(out).length >= MAX_KEYS) break
  }
  return out
}

/**
 * @returns {Promise<{ url, status, contentType, format: 'json'|'xml'|'text', structure, truncated }>}
 */
async function sampleResponse(raw, { get = pinnedGet, lookup } = {}) {
  const { url, address, family } = await checkUrl(raw, { lookup })
  let res
  try {
    res = await get(url, { address, family })
  } catch (e) {
    throw fail('SAMPLE_UNREACHABLE', `no answer from ${url.host}: ${e.code || e.message}`)
  }
  if (res.status >= 300 && res.status < 400) throw fail('SAMPLE_REDIRECT', `the endpoint redirects (HTTP ${res.status}); redirects are not followed — use the final URL`)
  const { contentType, text, truncated } = res
  const base = { url: url.href, status: res.status, contentType, truncated }
  try {
    return { ...base, format: 'json', structure: jsonShape(JSON.parse(text)) }
  } catch {
    // not JSON (or cut off)
  }
  if (/^\s*</.test(text)) {
    const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml')
    if (doc?.documentElement) return { ...base, format: 'xml', structure: { [doc.documentElement.nodeName]: xmlShape(doc.documentElement) } }
  }
  return { ...base, format: 'text', structure: `text: ${JSON.stringify(text.slice(0, 200))}${text.length > 200 ? '…' : ''}` }
}

module.exports = { sampleResponse, checkUrl, isPublicAddress, pinnedGet, jsonShape, xmlShape }
