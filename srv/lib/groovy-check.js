/**
 * Client of the Groovy syntax check sidecar (groovy-check/, a small Java app): parse-only check
 * of Groovy scripts before a proposal. Configured by env:
 * - GROOVY_CHECK_URL: base URL, e.g. http://localhost:4010 (locally: npm run groovy-check)
 * - GROOVY_CHECK_TOKEN: shared token, sent as x-check-token
 * - GROOVY_CHECK_REQUIRED: "true" = an unavailable checker blocks proposals; otherwise the
 *   scripts are reported as not checked and the proposal goes on
 * - GROOVY_CHECK_TIMEOUT_MS: per request (default 15000)
 * Real environment variables win over .env: a GROOVY_CHECK_URL exported in the shell points the app
 * elsewhere than .env says. Failures therefore log the URL, the network cause and the sidecar's
 * /health at that moment.
 */
const cds = require('@sap/cds')

const LOG = cds.log('groovy-check')
const timeoutMs = () => Number(process.env.GROOVY_CHECK_TIMEOUT_MS || 15_000)

const env = (name) => process.env[name] || ''

/**
 * @param {{ fileName: string, code: string }[]} scripts
 * @returns {Promise<{ checked: boolean, errors: { fileName: string, line: number, column: number, message: string }[], reason?: string }>}
 */
async function checkScripts(scripts) {
  if (!scripts.length) return { checked: true, errors: [] }
  const url = env('GROOVY_CHECK_URL').replace(/\/$/, '')
  if (!url) return { checked: false, errors: [], reason: 'GROOVY_CHECK_URL is not set' }
  const post = () =>
    fetch(`${url}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env('GROOVY_CHECK_TOKEN') && { 'x-check-token': env('GROOVY_CHECK_TOKEN') }) },
      body: JSON.stringify({ scripts }),
      signal: AbortSignal.timeout(timeoutMs())
    })
  try {
    let res
    try {
      res = await post()
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw e
      LOG.info(`Groovy syntax check: ${describe(e)}, retrying once`) // a dropped connection
      res = await post()
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || res.statusText}`)
    const errors = (data.results || []).flatMap((r) => (r.errors || []).map((e) => ({ fileName: r.fileName, line: e.line, column: e.column, message: e.message })))
    return { checked: true, errors }
  } catch (e) {
    const reason = `${describe(e)} at ${url}`
    const health = await probe(url)
    LOG.warn(`Groovy syntax check unavailable: ${reason}; sidecar health now: ${health}`)
    return { checked: false, errors: [], reason }
  }
}

/** The sidecar's /health right now, for the log: "UP (uptime 12s, 1 check running, 40 total)" or "down (ECONNREFUSED)" */
async function probe(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return `HTTP ${res.status}`
    const h = await res.json().catch(() => ({}))
    return `${h.status || 'UP'} (uptime ${Math.round((h.uptimeMs || 0) / 1000)}s, ${h.checksRunning ?? '?'} check(s) running, ${h.checksTotal ?? '?'} total)`
  } catch (e) {
    return `down (${e.name === 'TimeoutError' ? 'no answer in 2s' : describe(e)})`
  }
}

/** "fetch failed" with its network cause, e.g. "fetch failed (ECONNREFUSED)" */
const describe = (e) => {
  const cause = e.cause?.code || e.cause?.message
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message
}

const required = () => env('GROOVY_CHECK_REQUIRED') === 'true'

/**
 * Checks every Groovy script a spec builds (written in the spec or attached) and returns a status
 * per file, as shown in the proposal panel and checked again at approval.
 * @returns {Promise<{ scripts: number, checked: boolean, reason?: string, failed: object[],
 *   files: Object<string, { status: 'ok'|'failed'|'unchecked', errors?: string[], reason?: string, at: string }> }>}
 */
async function checkSpecScripts(spec, attachments = {}, { check = checkScripts } = {}) {
  const { injectAttachments } = require('../iflow-builder/builder')
  const filled = injectAttachments(spec, attachments)
  const scripts = [...(filled.steps || []), ...(filled.exceptionSubprocess?.steps || [])]
    .filter((s) => s?.type === 'groovyScript' && typeof s.code === 'string')
    .map((s) => ({ fileName: `${s.fileName}.groovy`, code: s.code }))
  if (!scripts.length) return { scripts: 0, checked: true, failed: [], files: {} }
  const { checked, errors, reason } = await check(scripts)
  const at = new Date().toISOString()
  const files = Object.fromEntries(
    scripts.map(({ fileName }) => {
      const own = errors.filter((e) => e.fileName === fileName)
      if (!checked) return [fileName, { status: 'unchecked', reason, at }]
      if (own.length) return [fileName, { status: 'failed', errors: own.map((e) => `${e.line}:${e.column}: ${e.message}`), at }]
      return [fileName, { status: 'ok', at }]
    })
  )
  return { scripts: scripts.length, checked, reason, failed: errors, files }
}

module.exports = { checkScripts, checkSpecScripts, required }
