const cds = require('@sap/cds')
const path = require('path')
const fs = require('fs')

// SAPUI5 app: the build (npm run ui:build) if present, else the sources — UI5 runs unbuilt
// (bootstrapped from the SAPUI5 CDN), so no build step is needed during development.
const UI_DIR = path.join(__dirname, 'app', 'integration-pilot')
const uiRoot = () => [path.join(UI_DIR, 'dist'), path.join(UI_DIR, 'webapp')].find((d) => fs.existsSync(path.join(d, 'index.html')))

// Friendly URL aliases for CAP REST paths (CAP operation/entity names cannot contain dashes or nest freely)
const ALIASES = [
  [/^\/api\/llm-health$/, '/api/llmHealth'],
  [/^\/api\/chat\/turns\/([^/]+)$/, '/api/ChatTurns/$1'],
  [/^\/api\/chat\/turns\/([^/]+)\/cancel$/, '/api/ChatTurns/$1/cancel']
]
cds.on('bootstrap', (app) => {
  app.use((req, _res, next) => {
    const [p, q] = req.url.split('?')
    const alias = ALIASES.find(([re]) => re.test(p))
    if (alias) req.url = p.replace(alias[0], alias[1]) + (q ? `?${q}` : '')
    next()
  })
})

// Proposal executions and chat turns run in-process: anything still running at startup was interrupted
cds.once('served', () => {
  require('./srv/lib/proposals')
    .recoverInterrupted()
    .catch((e) => cds.log('proposals').error('Recovery of interrupted proposals failed', e))
  require('./srv/agent/agent')
    .recoverInterruptedTurns()
    .catch((e) => cds.log('agent').error('Recovery of interrupted chat turns failed', e))
  startConversationCleanup()
})

/**
 * Deletes conversations without activity for CONVERSATION_RETENTION_DAYS days (default 14; kept ones
 * stay): at startup and once a day. CONVERSATION_CLEANUP_TIMER=false switches the timer off when a
 * scheduler calls POST /api/cleanupConversations instead (e.g. SAP BTP Job Scheduler).
 */
function startConversationCleanup() {
  if (process.env.CONVERSATION_CLEANUP_TIMER === 'false' || process.env.NODE_ENV === 'test') return
  const LOG = cds.log('cleanup')
  const { audit } = require('./srv/lib/audit')
  const agent = require('./srv/agent/agent')
  const run = async () => {
    try {
      const r = await agent.deleteInactiveSessions()
      if (!r.days) return
      LOG.info(`Conversations without activity for ${r.days} days: ${r.deleted} deleted, ${r.skipped} skipped`)
      if (r.deleted || r.skipped)
        await audit({ user: { id: 'system' } }, { action: 'CLEANUP_CONVERSATIONS', targetType: 'ChatSession', targetId: 'all', status: 'SUCCESS', details: r })
    } catch (e) {
      LOG.error('Conversation cleanup failed', e)
    }
  }
  run()
  setInterval(run, 24 * 3600_000).unref()
}

// By default CAP serves the whole ./app folder statically, which would expose
// node_modules and the approuter. Serve only the UI5 app at "/" (it uses hash routing,
// so no SPA fallback is needed).
// SQLite on Cloud Foundry (CDS_ENV=sqlite) is in-memory: deploy the schema at startup.
// Data does not survive restarts — use the HANA Cloud variant (mta.yaml) to keep it.
const inMemoryDb = () => cds.env.requires.db?.kind === 'sqlite' && cds.env.requires.db.credentials?.url === ':memory:'

module.exports = (options) => cds.server({ ...options, static: uiRoot() || false, in_memory: options.in_memory || inMemoryDb() })
