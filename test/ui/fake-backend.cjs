/**
 * Preload for the UI tests (node -r ./test/ui/fake-backend.cjs …): replaces the AI model
 * (srv/lib/llm.js), the CPI tenant (srv/lib/cpi-client.js) and the Groovy check with
 * deterministic in-process fakes before CAP loads them, so the real app (CAP service, agent,
 * builder, UI5 app) runs end to end without network access.
 *
 * The fake model reacts to the last user message:
 * - contains "UITEST_PROPOSE": validateSpec (sample spec) -> proposeIflow -> answer
 * - contains "UITEST_NEWPKG": the same, in a package that does not exist (package selection)
 * - contains "UITEST_UNCHECKED": the same, with the Groovy check unreachable until the next message
 * - anything else: a short answer
 * Every answer reports usage (1000 input / 100 output tokens per model call).
 */
const path = require('path')

const SRV = path.join(__dirname, '..', '..', 'srv')
const sample = require(path.join(SRV, 'iflow-builder', 'samples', 'Pilot_Test_1.json'))

const usage = { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, durationMs: 5 }
const reply = (message) => ({ model: 'fake/model', fallbackUsed: false, usage, choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: null, ...message } }] })
const toolCall = (name, args) => reply({ tool_calls: [{ id: `${name}:${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

const llm = {
  RATE_LIMIT_MESSAGE: 'rate limited',
  stripThinking: (s) => s,
  cleanMessage: (m) => m,
  normalizeUsage: () => usage,
  async health() {
    return { ok: true, model: 'fake/model', fallbackUsed: false, latencyMs: 1, reply: 'OK', error: null }
  },
  async chat({ messages }) {
    const lastUser = messages.map((m) => m.role).lastIndexOf('user')
    const text = String(messages[lastUser]?.content || '')
    const toolResults = messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length
    groovyDown = text.includes('UITEST_UNCHECKED')
    if (text.includes('UITEST_PROPOSE') || text.includes('UITEST_NEWPKG') || text.includes('UITEST_UNCHECKED')) {
      const spec = { ...sample, id: `UI_Test_${Date.now().toString(36)}`, name: 'UI Test Flow', ...(text.includes('UITEST_NEWPKG') && { packageId: 'Ui.New.Package' }) }
      if (toolResults === 0) return toolCall('validateSpec', { spec })
      if (toolResults === 1) return toolCall('proposeIflow', { useValidatedSpec: true })
      return reply({ content: 'The proposal is ready for review in the proposal panel.' })
    }
    return reply({ content: `Fake answer to: ${text.slice(0, 60)}` })
  }
}

// --- CPI: one package, iFlows kept in memory ------------------------------------------------
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'CPI_NOT_FOUND' })
const packages = [{ id: 'PilotReference', name: 'Pilot Reference', shortText: 'Reference iFlows', version: '1.0.0' }]
const iflows = new Map()

const cpi = {
  MESSAGE_STATUSES: ['FAILED', 'COMPLETED', 'PROCESSING', 'RETRY', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED'],
  async health() {
    return { connected: true, tenantHost: 'fake-tenant.example.com', latencyMs: 1, error: null }
  },
  async listPackages() {
    return packages
  },
  async getPackage(id) {
    const p = packages.find((x) => x.id === id)
    if (!p) throw notFound(`Package ${id}`)
    return p
  },
  async createPackage(p) {
    packages.push({ ...p, version: '1.0.0' })
    return p
  },
  async listIflows(packageId) {
    return [...iflows.values()].filter((f) => f.packageId === packageId)
  },
  async getIflow(id) {
    if (!iflows.has(id)) throw notFound(`iFlow ${id}`)
    return iflows.get(id)
  },
  async createIflow({ id, name, packageId, zipBase64 }) {
    iflows.set(id, { id, name, packageId, version: '1.0.0', zipBase64 })
    return iflows.get(id)
  },
  async updateIflowContent(id, { zipBase64 }) {
    iflows.set(id, { ...(await cpi.getIflow(id)), zipBase64 })
    return iflows.get(id)
  },
  async downloadIflowZip(id) {
    return Buffer.from((await cpi.getIflow(id)).zipBase64 || '', 'base64')
  },
  async saveIflowAsVersion() {},
  async getConfigurations() {
    return []
  },
  async updateConfiguration() {},
  async deployIflow() {
    return { taskId: 'fake-task' }
  },
  async getDeployStatus() {
    return 'SUCCESS'
  },
  async listRuntimeArtifacts() {
    return []
  },
  async getRuntimeArtifact() {
    return null
  },
  async getRuntimeError() {
    return null
  },
  async listMessageLogs() {
    return []
  },
  async listResources() {
    return []
  },
  invalidateCache() {}
}
for (const name of ['updatePackage', 'deletePackage', 'downloadPackageZip', 'deleteIflow', 'getResource', 'upsertResource', 'undeployIflow'])
  cpi[name] = async () => {
    throw Object.assign(new Error(`${name} is not part of the UI test fake`), { status: 501 })
  }

// the real per-file logic (checkSpecScripts) on top of a fake sidecar call
let groovyDown = false
const realGroovyCheck = require(path.join(SRV, 'lib', 'groovy-check.js'))
const groovyCheck = {
  async checkScripts() {
    return groovyDown ? { checked: false, errors: [], reason: 'fetch failed (ECONNREFUSED) at http://localhost:4010' } : { checked: true, errors: [] }
  },
  required: () => false,
  checkSpecScripts: (spec, attachments) => realGroovyCheck.checkSpecScripts(spec, attachments, { check: groovyCheck.checkScripts })
}

const fake = (file, exports) => {
  const filename = require.resolve(path.join(SRV, 'lib', file))
  const mod = new (require('module'))(filename)
  mod.filename = filename
  mod.loaded = true
  mod.exports = exports
  require.cache[filename] = mod
}
fake('llm.js', llm)
fake('cpi-client.js', cpi)
fake('groovy-check.js', groovyCheck)
console.log('[ui-test] AI model, CPI tenant and Groovy check are faked')
