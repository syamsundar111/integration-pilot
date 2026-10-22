/**
 * Design-time sample of a public GET endpoint: fetches one response and returns only its structure
 * (keys, types, short example values), so the model writes a script against the real data shape
 * (e.g. OData V2 {"d":{"results":[...]}} with decimals as strings) instead of guessing.
 *
 * The server fetches a URL the model chooses, so it only reaches the public internet: http(s) only,
 * no credentials in the URL, the host must resolve to public addresses only, redirects are not
 * followed, 8 s timeout, at most 256 KB read.
 */
const dns = require('dns').promises
const net = require('net')
const { DOMParser } = require('@xmldom/xmldom')

const TIMEOUT_MS = 8000
const MAX_BYTES = 256 * 1024
const MAX_DEPTH = 5
const MAX_KEYS = 30

/** Loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, unique-local, multicast, reserved */
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224)
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7))
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff'))
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
  return url
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
async function sampleResponse(raw, { fetchImpl = fetch, lookup } = {}) {
  const url = await checkUrl(raw, { lookup })
  let res
  try {
    res = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json, application/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw fail('SAMPLE_UNREACHABLE', `no answer from ${url.host}: ${e.cause?.code || e.message}`)
  }
  if (res.status >= 300 && res.status < 400) throw fail('SAMPLE_REDIRECT', `the endpoint redirects (HTTP ${res.status}); redirects are not followed — use the final URL`)
  const contentType = res.headers.get('content-type') || ''
  // read at most MAX_BYTES
  const reader = res.body?.getReader?.()
  const chunks = []
  let size = 0
  let truncated = false
  if (reader)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      if (size >= MAX_BYTES) {
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
    }
  const text = reader ? Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, MAX_BYTES) : (await res.text()).slice(0, MAX_BYTES)
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

module.exports = { sampleResponse, checkUrl, isPublicAddress, jsonShape, xmlShape }
