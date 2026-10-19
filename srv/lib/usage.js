/**
 * AI usage summary for the Activity page: chat turns of the last N days, with totals, one row
 * per day and one per model. Aggregated in JavaScript, so it works the same on SQLite and HANA.
 */
const cds = require('@sap/cds')

const MAX_DAYS = 365

/**
 * @param {{ days?: number, user?: object }} options
 * @returns {Promise<{ days: number, since: string, totals: object, byDay: object[], byModel: object[] }>}
 */
async function usageSummary({ days = 30, user } = {}) {
  days = Math.min(Math.max(Math.round(Number(days) || 30), 1), MAX_DAYS)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const turns = await cds.tx({ user }, (tx) =>
    tx.run(
      SELECT.from('iflowpilot.ChatTurn')
        .columns('createdAt', 'status', 'modelCalls', 'inputTokens', 'outputTokens', 'totalTokens', 'durationMs', 'model', 'stoppedAtBudget')
        .where({ createdAt: { '>=': since }, status: { '!=': 'RUNNING' } })
    )
  )
  const empty = () => ({ requests: 0, failed: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 })
  const add = (acc, t) => {
    acc.requests++
    if (t.status === 'FAILED') acc.failed++
    acc.modelCalls += t.modelCalls || 0
    acc.inputTokens += t.inputTokens || 0
    acc.outputTokens += t.outputTokens || 0
    acc.totalTokens += t.totalTokens || 0
    acc.durationMs += t.durationMs || 0
    return acc
  }
  const totals = empty()
  const byDay = {}
  const byModel = {}
  for (const t of turns) {
    add(totals, t)
    add((byDay[String(t.createdAt).slice(0, 10)] ??= empty()), t)
    for (const m of String(t.model || '').split(', ').filter(Boolean)) add((byModel[m] ??= empty()), t)
  }
  const avg = (acc) => ({ ...acc, avgTokensPerRequest: acc.requests ? Math.round(acc.totalTokens / acc.requests) : 0 })
  // the token budget per message (AGENT_MAX_TOKENS_PER_MESSAGE): how close requests come to it
  const limit = Number(process.env.AGENT_MAX_TOKENS_PER_MESSAGE || 300_000)
  const maxPerRequest = Math.max(0, ...turns.map((t) => t.totalTokens || 0))
  const budget = {
    limit,
    maxPerRequest,
    maxShare: limit ? Math.round((maxPerRequest / limit) * 100) : 0,
    avgPerRequest: totals.requests ? Math.round(totals.totalTokens / totals.requests) : 0,
    stoppedAtBudget: turns.filter((t) => t.stoppedAtBudget).length
  }
  return {
    days,
    since,
    budget,
    totals: avg(totals),
    byDay: Object.entries(byDay)
      .map(([day, acc]) => ({ day, ...avg(acc) }))
      .sort((a, b) => b.day.localeCompare(a.day)),
    byModel: Object.entries(byModel)
      .map(([model, acc]) => ({ model, ...avg(acc) }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
  }
}

module.exports = { usageSummary }
