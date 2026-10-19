/**
 * Client of the Groovy syntax check sidecar (groovy-check/, a small Java app): parse-only check
 * of Groovy scripts before a proposal. Configured by env:
 * - GROOVY_CHECK_URL: base URL, e.g. http://localhost:4010 (locally: npm run groovy-check)
 * - GROOVY_CHECK_TOKEN: shared token, sent as x-check-token
 * - GROOVY_CHECK_REQUIRED: "true" = an unavailable checker blocks proposals; otherwise the
 *   scripts are reported as not checked and the proposal goes on
 */
const cds = require('@sap/cds')

const LOG = cds.log('groovy-check')
const TIMEOUT_MS = 15_000

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
      signal: AbortSignal.timeout(TIMEOUT_MS)
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
    LOG.warn(`Groovy syntax check unavailable: ${describe(e)}`)
    return { checked: false, errors: [], reason: describe(e) }
  }
}

/** "fetch failed" with its network cause, e.g. "fetch failed (ECONNREFUSED)" */
const describe = (e) => {
  const cause = e.cause?.code || e.cause?.message
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message
}

const required = () => env('GROOVY_CHECK_REQUIRED') === 'true'

module.exports = { checkScripts, required }
