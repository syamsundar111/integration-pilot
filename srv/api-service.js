const cds = require('@sap/cds')
const cpi = require('./lib/cpi-client')
const llm = require('./lib/llm')
const agent = require('./agent/agent')
const proposals = require('./lib/proposals')
const { audited } = require('./lib/audit')
const { getStats } = require('./lib/stats')
const { explain, parsedIflow } = require('./lib/explain')
const { usageSummary } = require('./lib/usage')

/** Key of the n-th entity in the URL path, e.g. /Packages/{id}/iflows -> keyOf(req) = id */
const keyOf = (req, i = 0) => Object.values(req.params.at(i) ?? {})[0]

const navigatedFrom = (req, entity) => req.query?.SELECT?.from?.ref?.[0]?.id === `ApiService.${entity}`

function requireFields(req, data, fields) {
  const missing = fields.filter((f) => data[f] == null || data[f] === '')
  if (missing.length) req.reject(400, `Missing required field(s): ${missing.join(', ')}`)
}

function sendZip(req, fileName, buffer) {
  const { res } = req.http
  res.set('Content-Type', 'application/zip')
  res.set('Content-Disposition', `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`)
  res.send(buffer)
}

module.exports = class ApiService extends cds.ApplicationService {
  init() {
    const { Packages, Iflows, Configurations, Resources, RuntimeArtifacts } = this.entities

    // --- Health -------------------------------------------------------------

    this.on('health', () => cpi.health())
    this.on('me', (req) => ({ id: req.user?.id || 'anonymous' }))
    this.on('stats', (req) => getStats({ fresh: !!req.data.fresh }))

    // --- Packages -----------------------------------------------------------

    this.on('READ', Packages, (req) => (req.params.length ? cpi.getPackage(keyOf(req)) : cpi.listPackages()))

    this.on('CREATE', Packages, (req) => {
      requireFields(req, req.data, ['id', 'name'])
      const { id, name, shortText, description, version } = req.data
      if (!/^[A-Za-z0-9.]+$/.test(id)) req.reject(400, 'Package id: use letters, digits and dots only — CPI does not allow underscores or other special characters')
      return audited(req, { action: 'CREATE_PACKAGE', targetType: 'Package', targetId: id, details: { name } }, () =>
        cpi.createPackage({ id, name, shortText, description, version })
      )
    })

    this.on('UPDATE', Packages, (req) => {
      const id = keyOf(req)
      const { name, shortText, description, version } = req.data
      const changes = { name, shortText, description, version }
      return audited(req, { action: 'UPDATE_PACKAGE', targetType: 'Package', targetId: id, details: changes }, () =>
        cpi.updatePackage(id, changes)
      )
    })

    this.on('DELETE', Packages, (req) => {
      const id = keyOf(req)
      return audited(req, { action: 'DELETE_PACKAGE', targetType: 'Package', targetId: id }, () => cpi.deletePackage(id))
    })

    this.on('download', Packages, async (req) => {
      const id = keyOf(req)
      sendZip(req, `${id}.zip`, await cpi.downloadPackageZip(id))
    })

    // --- iFlows -------------------------------------------------------------

    this.on('READ', Iflows, (req) => {
      if (req.query.SELECT.one) return cpi.getIflow(keyOf(req, -1)) // /Iflows/{id}
      if (navigatedFrom(req, 'Packages')) return cpi.listIflows(keyOf(req)) // /Packages/{id}/iflows
      req.reject(400, 'iFlows are listed per package: GET /api/Packages/{packageId}/iflows')
    })

    this.on('CREATE', Iflows, (req) => {
      requireFields(req, req.data, ['id', 'name', 'packageId'])
      const { id, name, packageId, zipBase64 } = req.data
      return audited(
        req,
        { action: 'CREATE_IFLOW', targetType: 'Iflow', targetId: id, details: { name, packageId, withContent: !!zipBase64 } },
        () => cpi.createIflow({ id, name, packageId, zipBase64 })
      )
    })

    // PATCH /Iflows/{id} { name?, zipBase64 } replaces the iFlow content
    this.on('UPDATE', Iflows, (req) => {
      const id = keyOf(req)
      const { name, zipBase64 } = req.data
      requireFields(req, req.data, ['zipBase64'])
      return audited(req, { action: 'UPDATE_IFLOW', targetType: 'Iflow', targetId: id, details: { name } }, () =>
        cpi.updateIflowContent(id, { name, zipBase64 })
      )
    })

    this.on('DELETE', Iflows, (req) => {
      const id = keyOf(req)
      return audited(req, { action: 'DELETE_IFLOW', targetType: 'Iflow', targetId: id }, () => cpi.deleteIflow(id))
    })

    this.on('download', Iflows, async (req) => {
      const id = keyOf(req)
      sendZip(req, `${id}.zip`, await cpi.downloadIflowZip(id))
    })

    this.on('deploy', Iflows, (req) => {
      const id = keyOf(req)
      return audited(req, { action: 'DEPLOY_IFLOW', targetType: 'Iflow', targetId: id }, () => cpi.deployIflow(id))
    })

    this.on('backups', Iflows, (req) => proposals.listBackups(keyOf(req), req.user))
    this.on('restore', Iflows, (req) => proposals.restoreBackup(keyOf(req), req.data.proposalId, req.user))

    this.on('undeploy', Iflows, (req) => {
      const id = keyOf(req)
      return audited(req, { action: 'UNDEPLOY_IFLOW', targetType: 'Iflow', targetId: id }, () => cpi.undeployIflow(id))
    })

    // --- Configurations -----------------------------------------------------

    this.on('READ', Configurations, async (req) => {
      if (!navigatedFrom(req, 'Iflows')) req.reject(400, 'Use GET /api/Iflows/{id}/configurations')
      const iflowId = keyOf(req)
      return (await cpi.getConfigurations(iflowId)).map((c) => ({ iflowId, ...c }))
    })

    this.on('updateConfigurations', Iflows, async (req) => {
      const iflowId = keyOf(req)
      const { parameters = [] } = req.data
      if (!parameters.length) req.reject(400, 'No parameters given')
      const keys = parameters.map((p) => p.key)
      if (keys.some((k) => !k)) req.reject(400, 'Every parameter needs a key')
      // values are not audited: they may contain environment-specific data
      await audited(req, { action: 'UPDATE_CONFIGURATION', targetType: 'Iflow', targetId: iflowId, details: { keys } }, async () => {
        for (const p of parameters) await cpi.updateConfiguration(iflowId, p.key, p.value, p.dataType || undefined)
      })
      return (await cpi.getConfigurations(iflowId)).map((c) => ({ iflowId, ...c }))
    })

    // --- Resources ----------------------------------------------------------

    this.on('READ', Resources, async (req) => {
      if (!navigatedFrom(req, 'Iflows')) req.reject(400, 'Use GET /api/Iflows/{id}/resources')
      const iflowId = keyOf(req)
      return (await cpi.listResources(iflowId)).map((r) => ({ iflowId, ...r }))
    })

    this.on('parsed', Iflows, async (req) => {
      const { files, ...parsed } = await parsedIflow({ iflowId: keyOf(req) })
      req.http.res.set('Content-Type', 'application/json')
      return parsed
    })

    this.on('explain', (req) => {
      const { iflowId, zipBase64 } = req.data
      if (!iflowId && !zipBase64) req.reject(400, 'Provide iflowId or zipBase64')
      return explain({ iflowId, zipBase64 })
    })

    this.on('resource', Iflows, (req) => {
      requireFields(req, req.data, ['name', 'type'])
      return cpi.getResource(keyOf(req), req.data.name, req.data.type)
    })

    // --- Runtime ------------------------------------------------------------

    // /RuntimeArtifacts, /RuntimeArtifacts/{id} and /Iflows/{id}/runtime (204 if not deployed)
    this.on('READ', RuntimeArtifacts, (req) =>
      req.query.SELECT.one ? cpi.getRuntimeArtifact(keyOf(req, -1)) : cpi.listRuntimeArtifacts()
    )

    this.on('errorInfo', RuntimeArtifacts, (req) => cpi.getRuntimeError(keyOf(req)))

    // --- Monitoring ---------------------------------------------------------

    this.on('messageLogs', (req) => cpi.listMessageLogs(req.data))

    // --- AI agent -----------------------------------------------------------

    this.on('llmHealth', () => llm.health())
    this.on('usage', (req) => usageSummary({ days: req.data.days, user: req.user }))

    this.on('chat', (req) => {
      const { sessionId, message, defaults, attachments } = req.data
      if (!message?.trim()) req.reject(400, 'message is required')
      return agent.startTurn({ sessionId, message, defaults, attachments, user: req.user })
    })

    this.on('importIflow', (req) => {
      const { sessionId, fileName, contentBase64, packageId } = req.data
      requireFields(req, req.data, ['fileName', 'contentBase64'])
      if (!/\.(zip|iflw)$/i.test(fileName)) req.reject(400, 'Import a .zip export of an iFlow or a .iflw file')
      return audited(req, { action: 'IMPORT_IFLOW', targetType: 'File', targetId: fileName, details: { fileName, sessionId: sessionId || 'new conversation' } }, () =>
        agent.importIntoSession({ sessionId, fileName, buffer: Buffer.from(contentBase64, 'base64'), packageId, user: req.user })
      )
    })

    this.on('remove', 'Attachments', async (req) => {
      const id = keyOf(req)
      const n = await DELETE.from('iflowpilot.Attachment', id)
      if (!n) req.reject(404, `Attachment ${id} not found`)
    })

    this.on('remove', 'ChatSessions', (req) => {
      const id = keyOf(req)
      return audited(req, { action: 'DELETE_CHAT_SESSION', targetType: 'ChatSession', targetId: id }, () => agent.deleteSession(id, req.user))
    })

    // Turns are returned with events/proposals/error parsed
    const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v)
    const parseTurn = (t) => t && { ...t, ...Object.fromEntries(['events', 'proposals', 'error'].filter((k) => k in t).map((k) => [k, parseJson(t[k])])) }
    this.on('READ', 'ChatTurns', async (req, next) => {
      const result = await next()
      return Array.isArray(result) ? result.map(parseTurn) : parseTurn(result)
    })
    this.on('cancel', 'ChatTurns', async (req) => {
      const id = keyOf(req)
      await agent.cancelTurn(id, req.user)
      return parseTurn(await SELECT.one.from('iflowpilot.ChatTurn', id))
    })

    // Proposals are returned with spec/result parsed, so clients get objects, not JSON strings
    const parseProposal = (p) =>
      p && {
        ...p,
        ...('spec' in p && { spec: parseJson(p.spec) }),
        ...('result' in p && { result: parseJson(p.result) }),
        ...('attachments' in p && { attachments: parseJson(p.attachments) }),
        ...('backup' in p && { backup: parseJson(p.backup) }),
        ...('scriptChecks' in p && { scriptChecks: parseJson(p.scriptChecks) })
      }
    this.on('READ', 'Proposals', async (req, next) => {
      const result = await next()
      return Array.isArray(result) ? result.map(parseProposal) : parseProposal(result)
    })

    this.on('approve', 'Proposals', async (req) =>
      parseProposal(await proposals.approve(keyOf(req), { deploy: !!req.data.deploy, acceptUnchecked: !!req.data.acceptUnchecked }, req.user))
    )
    this.on('reject', 'Proposals', async (req) => parseProposal(await proposals.reject(keyOf(req), { reason: req.data.reason }, req.user)))
    this.on('setPackage', 'Proposals', async (req) =>
      parseProposal(await proposals.setPackage(keyOf(req), { packageId: req.data.packageId, packageName: req.data.packageName }, req.user))
    )
    this.on('retry', 'Proposals', async (req) =>
      parseProposal(await proposals.retry(keyOf(req), { deploy: req.data.deploy ?? undefined, acceptUnchecked: !!req.data.acceptUnchecked }, req.user))
    )

    return super.init()
  }
}
