/**
 * Dashboard KPIs. CPI has no "list all iFlows" call, so the total iFlow count loops
 * over all packages (a few at a time). The combined result is cached for 30s.
 */
const cds = require('@sap/cds')
const cpi = require('./cpi-client')

const LOG = cds.log('stats')
const TTL_MS = 30_000
const CONCURRENCY = 4
const FAILED_LOG_CAP = 500

let cache = null // { value, expires }
let inflight = null

/** Runs fn over items with at most `limit` in parallel */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function compute() {
  const started = Date.now()
  const [packages, runtime, failed] = await Promise.all([
    cpi.listPackages(),
    cpi.listRuntimeArtifacts(),
    cpi.listMessageLogs({ status: 'FAILED', sinceHours: 24, top: FAILED_LOG_CAP }).catch((e) => {
      LOG.warn('message logs unavailable for stats:', e.message)
      return null
    })
  ])

  let unreadable = 0
  const perPackage = await mapLimit(packages, CONCURRENCY, async (p) => {
    try {
      return (await cpi.listIflows(p.id)).length
    } catch (e) {
      // e.g. partner content without access: count what we can, report the gap
      unreadable++
      LOG.warn(`iFlows of package ${p.id} not readable:`, e.message)
      return 0
    }
  })

  const iflowRuntime = runtime.filter((r) => r.type === 'INTEGRATION_FLOW')
  const count = (status) => iflowRuntime.filter((r) => r.status === status).length
  return {
    packages: packages.length,
    iflows: perPackage.reduce((a, b) => a + b, 0),
    packagesNotReadable: unreadable,
    deployed: iflowRuntime.length,
    started: count('STARTED'),
    starting: count('STARTING'),
    error: count('ERROR'),
    failedMessages24h: failed ? failed.length : null,
    failedMessages24hCapped: failed ? failed.length >= FAILED_LOG_CAP : false,
    computedAt: new Date().toISOString(),
    durationMs: Date.now() - started
  }
}

/** @param {{ fresh?: boolean }} options - fresh bypasses the 30s cache */
async function getStats({ fresh = false } = {}) {
  if (!fresh && cache && cache.expires > Date.now()) return cache.value
  // concurrent dashboard loads share one computation
  inflight ??= compute()
    .then((value) => {
      cache = { value, expires: Date.now() + TTL_MS }
      return value
    })
    .finally(() => (inflight = null))
  return inflight
}

module.exports = { getStats, mapLimit }
