/**
 * Proposal execution — no LLM involved.
 *
 * approve(): claims a PENDING proposal (-> APPROVED), then runs in the background:
 *   ensure package -> build zip -> create or update iFlow -> set configurations -> (deploy -> poll runtime)
 * retry(): re-runs a FAILED proposal the same way. Every step is safe to re-run:
 *   existing packages are reused and an existing iFlow (same package) is updated.
 * Progress is written to Proposal.result after every step, so the UI can poll
 * GET /api/Proposals/{id}. Final status: DONE or FAILED (with error).
 */
const cds = require('@sap/cds')
const cpi = require('./cpi-client')
const { audit, audited } = require('./audit')
const { build } = require('../iflow-builder/builder')
const groovyCheck = require('./groovy-check')

const LOG = cds.log('proposals')
const POLL_INTERVAL_MS = Number(process.env.DEPLOY_POLL_INTERVAL_MS || 5_000)
const POLL_TIMEOUT_MS = Number(process.env.DEPLOY_POLL_TIMEOUT_MS || 120_000)
const INTERRUPTED = 'Execution interrupted by server restart — retry'

const db = (user, fn) => cds.tx({ user }, fn)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const entity = () => cds.entities('iflowpilot').Proposal
const parse = (json) => (json ? JSON.parse(json) : {})

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function plan(kind, deploy, operation) {
  const steps =
    kind === 'PACKAGE'
      ? [{ key: 'package', label: 'Create package' }]
      : [
          { key: 'check', label: 'Check Groovy scripts' },
          { key: 'package', label: 'Ensure package exists' },
          ...(operation === 'UPDATE' ? [{ key: 'backup', label: 'Back up current iFlow' }] : []),
          { key: 'build', label: 'Build iFlow' },
          { key: 'create', label: operation === 'UPDATE' ? 'Update iFlow' : 'Create or update iFlow' },
          { key: 'configure', label: 'Set externalized parameters' },
          ...(deploy ? [{ key: 'deploy', label: 'Deploy' }, { key: 'runtime', label: 'Wait for runtime status' }] : [])
        ]
  return steps.map((s) => ({ ...s, status: 'pending', detail: null }))
}

/**
 * Atomically moves a proposal from `fromStatus` to APPROVED with a fresh step plan,
 * then starts execution in the background.
 */
async function claimAndRun(id, fromStatus, action, makeResult, user) {
  const Proposal = entity()
  const { p, r } = await db(user, async (tx) => {
    const p = await tx.run(SELECT.one.from(Proposal, id))
    if (!p) throw fail(404, 'PROPOSAL_NOT_FOUND', `Proposal ${id} not found`)
    const r = makeResult(p)
    // Atomic claim: only one request can win
    const claimed = await tx.run(UPDATE(Proposal).set({ status: 'APPROVED', result: JSON.stringify(r), error: null }).where({ ID: id, status: fromStatus }))
    if (!claimed) throw fail(409, `PROPOSAL_NOT_${fromStatus}`, `Proposal is ${p.status}; only ${fromStatus} proposals can be ${action === 'RETRY_PROPOSAL' ? 'retried' : 'approved'}.`)
    return { p, r }
  })
  await audit({ user }, { action, targetType: 'Proposal', targetId: id, status: 'SUCCESS', details: { kind: p.kind, deploy: r.deploy, attempt: r.attempt, ...(r.acceptedUnchecked && { acceptedUncheckedGroovy: true }) } })

  execute(p, r, user).catch((e) => LOG.error(`Proposal ${id} execution crashed`, e))
  return db(user, (tx) => tx.run(SELECT.one.from(Proposal, id)))
}

/**
 * Checks the Groovy scripts of an iFlow proposal again before it is executed and stores the status
 * per file. A syntax error blocks; an unreachable checker blocks unless the approver accepted that
 * (acceptUnchecked). Returns the result of the 'check' execution step.
 */
async function recheckScripts(id, fromStatus, acceptUnchecked, user) {
  const Proposal = entity()
  const p = await db(user, (tx) => tx.run(SELECT.one.from(Proposal, id).columns('ID', 'kind', 'status', 'spec', 'attachments')))
  if (!p) throw fail(404, 'PROPOSAL_NOT_FOUND', `Proposal ${id} not found`)
  if (p.kind !== 'IFLOW' || p.status !== fromStatus) return null // the claim reports a wrong status
  const r = await groovyCheck.checkSpecScripts(JSON.parse(p.spec), parse(p.attachments))
  if (!r.scripts) return { status: 'skipped', detail: 'No Groovy scripts' }
  await db(user, (tx) => tx.run(UPDATE(Proposal, id).set({ scriptChecks: JSON.stringify(r.files) })))
  if (r.failed.length) {
    const list = r.failed.map((e) => `${e.fileName}:${e.line}:${e.column}: ${e.message}`).join('; ')
    throw Object.assign(fail(409, 'GROOVY_SYNTAX', `Approval blocked: ${r.failed.length} Groovy syntax error(s): ${list}`), {
      hint: 'Ask the assistant to fix the script, or fix the attached file and attach it again.'
    })
  }
  if (!r.checked) {
    if (!acceptUnchecked)
      throw Object.assign(fail(409, 'GROOVY_NOT_CHECKED', `${r.scripts} Groovy script(s) could not be checked: ${r.reason}.`), {
        hint: 'Approve again and accept that the scripts are not checked, or try again when the Groovy check is reachable.'
      })
    return { status: 'warning', detail: `Not checked (${r.reason}); approved without the check` }
  }
  return { status: 'done', detail: `${r.scripts} script(s) checked, no syntax errors` }
}

/** The plan with the result of the approval-time Groovy check filled in */
const withCheck = (steps, check) => steps.map((s) => (s.key === 'check' ? (check ? { ...s, ...check, finishedAt: new Date().toISOString() } : { ...s, status: 'skipped', detail: 'No Groovy scripts' }) : s))

/**
 * @param {string} id
 * @param {{ deploy?: boolean, acceptUnchecked?: boolean }} options - acceptUnchecked: approve although
 *   the Groovy check is unreachable (recorded in the audit log)
 * @param {{ id: string }} user - cds.User of the approver
 * @returns the proposal after claiming it (execution continues in the background)
 */
async function approve(id, { deploy = false, acceptUnchecked = false } = {}, user) {
  const check = await recheckScripts(id, 'PENDING', acceptUnchecked, user)
  return claimAndRun(
    id,
    'PENDING',
    'APPROVE_PROPOSAL',
    (p) => ({ deploy: !!deploy, approvedBy: user?.id, attempt: 1, ...(check?.status === 'warning' && { acceptedUnchecked: true }), steps: withCheck(plan(p.kind, deploy, p.operation), check) }),
    user
  )
}

/** Re-runs a FAILED proposal; `deploy` defaults to the choice of the previous attempt */
async function retry(id, { deploy, acceptUnchecked = false } = {}, user) {
  const check = await recheckScripts(id, 'FAILED', acceptUnchecked, user)
  return claimAndRun(
    id,
    'FAILED',
    'RETRY_PROPOSAL',
    (p) => {
      const prev = parse(p.result)
      const d = deploy ?? !!prev.deploy
      return {
        deploy: d,
        approvedBy: prev.approvedBy || user?.id,
        retriedBy: user?.id,
        attempt: (prev.attempt || 1) + 1,
        previousError: p.error,
        ...(check?.status === 'warning' && { acceptedUnchecked: true }),
        steps: withCheck(plan(p.kind, d, p.operation), check)
      }
    },
    user
  )
}

const PACKAGE_ID = /^[A-Za-z0-9.]+$/ // CPI rejects underscores and other special characters

/**
 * Retargets a PENDING iFlow proposal to another package. With packageName the package
 * is created on approval (if it still does not exist); without, it must exist already.
 */
async function setPackage(id, { packageId, packageName } = {}, user) {
  const Proposal = entity()
  if (!packageId || !PACKAGE_ID.test(packageId))
    throw fail(400, 'INVALID_PACKAGE_ID', 'Package id: use letters, digits and dots only — CPI does not allow underscores or other special characters')
  const name = packageName?.trim() || null
  if (!name) {
    let exists = true
    try {
      await cpi.getPackage(packageId)
    } catch (e) {
      if (e.status !== 404) throw e
      exists = false
    }
    if (!exists) throw fail(400, 'PACKAGE_NOT_FOUND', `Package '${packageId}' does not exist. Choose an existing package or give a name to create it.`)
  }
  const p = await db(user, async (tx) => {
    const p = await tx.run(SELECT.one.from(Proposal, id))
    if (!p) throw fail(404, 'PROPOSAL_NOT_FOUND', `Proposal ${id} not found`)
    if (p.kind !== 'IFLOW') throw fail(400, 'NOT_AN_IFLOW_PROPOSAL', 'Only iFlow proposals have a target package.')
    if (p.operation === 'UPDATE') throw fail(400, 'UPDATE_KEEPS_PACKAGE', 'An update changes an existing iFlow in its own package; the package cannot be changed.')
    const spec = JSON.parse(p.spec)
    spec.packageId = packageId
    const done = await tx.run(UPDATE(Proposal).set({ spec: JSON.stringify(spec), packageId, packageName: name }).where({ ID: id, status: 'PENDING' }))
    if (!done) throw fail(409, 'PROPOSAL_NOT_PENDING', `Proposal is ${p.status}; only PENDING proposals can be changed.`)
    return p
  })
  await audit({ user }, { action: 'UPDATE_PROPOSAL', targetType: 'Proposal', targetId: id, status: 'SUCCESS', details: { from: p.packageId, packageId, packageName: name } })
  return db(user, (tx) => tx.run(SELECT.one.from(Proposal, id)))
}

async function reject(id, { reason } = {}, user) {
  const Proposal = entity()
  const p = await db(user, async (tx) => {
    const p = await tx.run(SELECT.one.from(Proposal, id))
    if (!p) throw fail(404, 'PROPOSAL_NOT_FOUND', `Proposal ${id} not found`)
    const done = await tx.run(UPDATE(Proposal).set({ status: 'REJECTED', result: JSON.stringify({ reason: reason || null, rejectedBy: user?.id }) }).where({ ID: id, status: 'PENDING' }))
    if (!done) throw fail(409, 'PROPOSAL_NOT_PENDING', `Proposal is ${p.status}; only PENDING proposals can be rejected.`)
    return p
  })
  await audit({ user }, { action: 'REJECT_PROPOSAL', targetType: 'Proposal', targetId: id, status: 'SUCCESS', details: { kind: p.kind, reason } })
  return db(user, (tx) => tx.run(SELECT.one.from(Proposal, id)))
}

/**
 * Called once at server startup: executions run in-process, so an APPROVED proposal
 * at startup was interrupted by a restart. Marks it FAILED so it can be retried.
 * Assumes a single app instance (v1).
 */
async function recoverInterrupted() {
  const Proposal = entity()
  const stuck = await db(undefined, (tx) => tx.run(SELECT.from(Proposal).where({ status: 'APPROVED' })))
  for (const p of stuck) {
    const r = parse(p.result)
    for (const s of r.steps || []) {
      if (s.status === 'running') Object.assign(s, { status: 'failed', detail: 'Interrupted by server restart' })
      else if (s.status === 'pending') s.status = 'skipped'
    }
    await db(undefined, (tx) =>
      tx.run(UPDATE(Proposal).set({ status: 'FAILED', error: INTERRUPTED, result: JSON.stringify(r) }).where({ ID: p.ID, status: 'APPROVED' }))
    )
    LOG.warn(`Proposal ${p.ID} was interrupted by a restart; marked FAILED (retry with POST /api/Proposals/${p.ID}/retry)`)
  }
  return stuck.length
}

// --- background execution ---------------------------------------------------------------

async function execute(proposal, result, user) {
  const Proposal = entity()
  const spec = JSON.parse(proposal.spec)
  const req = { user } // for audit entries
  const save = (patch = {}) => db(user, (tx) => tx.run(UPDATE(Proposal, proposal.ID).set({ result: JSON.stringify(result), ...patch })))

  const step = async (key, fn) => {
    const s = result.steps.find((x) => x.key === key)
    s.status = 'running'
    s.startedAt = new Date().toISOString()
    await save()
    try {
      const out = await fn()
      if (out && typeof out === 'object') Object.assign(s, out) // { status: 'warning', detail }
      else {
        s.status = out === 'skipped' ? 'skipped' : 'done'
        s.detail = out === 'skipped' ? 'Nothing to do' : out || null
      }
    } catch (e) {
      s.status = 'failed'
      s.detail = e.message
      for (const rest of result.steps.filter((x) => x.status === 'pending')) rest.status = 'skipped'
      throw e
    } finally {
      s.finishedAt = new Date().toISOString()
      await save()
    }
  }

  try {
    if (proposal.kind === 'PACKAGE') {
      await step('package', async () => {
        if (await packageExists(spec.id)) return `Package ${spec.id} already exists`
        await audited(req, { action: 'CREATE_PACKAGE', targetType: 'Package', targetId: spec.id, details: { proposal: proposal.ID } }, () => cpi.createPackage(spec))
        return `Created package ${spec.id}`
      })
    } else {
      await step('package', () => ensurePackage(spec.packageId, proposal, req))
      if (proposal.operation === 'UPDATE') await step('backup', () => backupIflow(spec.id, proposal, result, req))

      let zip
      await step('build', async () => {
        zip = await build(spec, { attachments: proposal.attachments ? JSON.parse(proposal.attachments) : {} })
        return `${zip.files.length} files, ${zip.summary.sizeBytes} bytes`
      })

      await step('create', async () => {
        const detail = await createOrUpdateIflow(spec, zip.zipBase64, proposal, req)
        result.created = { iflowId: spec.id, packageId: spec.packageId }
        return detail
      })

      await step('configure', async () => {
        const params = Object.entries(spec.parameters || {})
        if (!params.length) return 'skipped'
        await audited(req, { action: 'UPDATE_CONFIGURATION', targetType: 'Iflow', targetId: spec.id, details: { keys: params.map(([k]) => k), proposal: proposal.ID } }, async () => {
          for (const [key, value] of params) await cpi.updateConfiguration(spec.id, key, value)
        })
        return `Set ${params.map(([k]) => k).join(', ')}`
      })

      if (result.deploy) {
        let taskId
        await step('deploy', async () => {
          ;({ taskId } = await audited(req, { action: 'DEPLOY_IFLOW', targetType: 'Iflow', targetId: spec.id, details: { proposal: proposal.ID } }, () => cpi.deployIflow(spec.id)))
          return `Deployment triggered${taskId ? ` (task ${taskId})` : ''}`
        })
        await step('runtime', async () => {
          const { status, pending } = await waitForRuntime(spec.id, taskId)
          result.runtimeStatus = status
          if (!pending) return `Runtime status ${status}`
          // CPI accepted the deployment but has not started it yet: not a failure (common on trial tenants)
          result.warning = `Deployment accepted, but the iFlow is not running yet (status ${status} after ${POLL_TIMEOUT_MS / 1000}s). Trial tenants can take several minutes — check the Monitor page.`
          return { status: 'warning', detail: result.warning }
        })
      }
    }

    await save({ status: 'DONE', error: null })
    LOG.info(`Proposal ${proposal.ID} done`)
  } catch (e) {
    const message = e.hint ? `${e.message} (${e.hint})` : e.message
    await save({ status: 'FAILED', error: message }).catch((err) => LOG.error('Could not save failure', err))
    LOG.warn(`Proposal ${proposal.ID} failed: ${message}`)
  }
}

async function packageExists(id) {
  try {
    await cpi.getPackage(id)
    return true
  } catch (e) {
    if (e.status === 404) return false
    throw e
  }
}

/** Creates the target package if it does not exist; uses a pending PACKAGE proposal's name if there is one */
async function ensurePackage(packageId, proposal, req) {
  if (await packageExists(packageId)) return `Package ${packageId} exists`
  const Proposal = entity()
  const pkgProposal = await db(req.user, (tx) =>
    tx.run(SELECT.one.from(Proposal).where({ session_ID: proposal.session_ID, kind: 'PACKAGE', packageId, status: 'PENDING' }))
  )
  // name chosen in the proposal panel > pending PACKAGE proposal of the session > the id itself
  const def = proposal.packageName
    ? { id: packageId, name: proposal.packageName, shortText: proposal.packageName }
    : pkgProposal
      ? JSON.parse(pkgProposal.spec)
      : { id: packageId, name: packageId, shortText: packageId }
  await audited(req, { action: 'CREATE_PACKAGE', targetType: 'Package', targetId: packageId, details: { proposal: proposal.ID } }, () => cpi.createPackage(def))
  if (pkgProposal)
    await db(req.user, (tx) =>
      tx.run(UPDATE(Proposal, pkgProposal.ID).set({ status: 'DONE', result: JSON.stringify({ note: `Created while executing proposal ${proposal.ID}` }) }))
    )
  return `Created package ${packageId}`
}

/** "1.0.2" -> "1.0.3"; anything else -> "1.0.1" */
function nextVersion(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)$/)
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.1'
}

/**
 * Before an update: stores the current iFlow zip with the proposal (for "Restore previous
 * version") and saves the current content as a CPI version. A missing CPI version is a
 * warning; a missing zip stops the update. A retry keeps the first backup, so it never
 * holds content written by this proposal.
 */
async function backupIflow(iflowId, proposal, result, req) {
  if (proposal.backupZip) return 'Backup from an earlier attempt kept'
  let current
  try {
    current = await cpi.getIflow(iflowId)
  } catch (e) {
    if (e.status === 404) throw fail(404, 'IFLOW_NOT_FOUND', `iFlow '${iflowId}' no longer exists, so it cannot be updated. Ask the assistant for a new iFlow instead.`)
    throw e
  }
  const zip = await cpi.downloadIflowZip(iflowId)
  const backup = { iflowId, version: current.version, sizeBytes: zip.length, at: new Date().toISOString() }
  try {
    const version = nextVersion(current.version)
    await audited(req, { action: 'SAVE_IFLOW_VERSION', targetType: 'Iflow', targetId: iflowId, details: { version, proposal: proposal.ID } }, () =>
      cpi.saveIflowAsVersion(iflowId, version)
    )
    backup.savedVersion = version
  } catch (e) {
    backup.versionError = e.message
  }
  const zipBase64 = zip.toString('base64')
  await db(req.user, (tx) => tx.run(UPDATE(entity(), proposal.ID).set({ backupZip: zipBase64, backup: JSON.stringify(backup) })))
  proposal.backupZip = zipBase64
  result.backup = backup
  const stored = `Backup of version ${backup.version} stored (${Math.ceil(backup.sizeBytes / 1024)} KB)`
  return backup.savedVersion
    ? `${stored}; saved as CPI version ${backup.savedVersion}`
    : { status: 'warning', detail: `${stored}; the CPI version could not be saved: ${backup.versionError}` }
}

/** Backups of an iFlow, newest first: [{ proposalId, createdAt, version, savedVersion, sizeBytes, at }] */
async function listBackups(iflowId, user) {
  const rows = await db(user, (tx) =>
    tx.run(SELECT.from(entity()).columns('ID', 'createdAt', 'backup').where({ iflowId, backup: { '!=': null } }).orderBy('createdAt desc'))
  )
  return rows.map((r) => ({ proposalId: r.ID, createdAt: r.createdAt, ...parse(r.backup) }))
}

/**
 * Puts a backup's zip back as the iFlow's content (not deployed); audited as RESTORE_IFLOW.
 * The content it replaces is saved as a CPI version first (a warning in the result if that fails).
 */
async function restoreBackup(iflowId, proposalId, user) {
  const Proposal = entity()
  const p = await db(user, (tx) =>
    proposalId
      ? tx.run(SELECT.one.from(Proposal).columns('ID', 'iflowId', 'backupZip', 'backup').where({ ID: proposalId }))
      : tx.run(SELECT.one.from(Proposal).columns('ID', 'iflowId', 'backupZip', 'backup').where({ iflowId, backup: { '!=': null } }).orderBy('createdAt desc'))
  )
  if (!p?.backupZip) throw fail(404, 'BACKUP_NOT_FOUND', proposalId ? `Proposal ${proposalId} has no backup` : `There is no backup of iFlow '${iflowId}'`)
  if (p.iflowId !== iflowId) throw fail(400, 'BACKUP_OTHER_IFLOW', `The backup of proposal ${p.ID} belongs to iFlow '${p.iflowId}', not '${iflowId}'`)
  const backup = parse(p.backup)
  const out = { iflowId, restoredFrom: { proposalId: p.ID, ...backup } }
  try {
    const version = nextVersion((await cpi.getIflow(iflowId)).version)
    await audited({ user }, { action: 'SAVE_IFLOW_VERSION', targetType: 'Iflow', targetId: iflowId, details: { version, before: 'RESTORE_IFLOW' } }, () => cpi.saveIflowAsVersion(iflowId, version))
    out.savedCurrentAs = version
  } catch (e) {
    out.warning = `The current content could not be saved as a CPI version first: ${e.message}`
  }
  await audited({ user }, { action: 'RESTORE_IFLOW', targetType: 'Iflow', targetId: iflowId, details: { proposal: p.ID, version: backup.version, at: backup.at, savedCurrentAs: out.savedCurrentAs } }, () =>
    cpi.updateIflowContent(iflowId, { zipBase64: p.backupZip })
  )
  return out
}

/**
 * Creates the iFlow, or updates its content if it already exists in the target package
 * (e.g. created by an earlier, interrupted attempt). An iFlow with the same id in a
 * different package is never overwritten.
 */
async function createOrUpdateIflow(spec, zipBase64, proposal, req) {
  let existing = null
  try {
    existing = await cpi.getIflow(spec.id)
  } catch (e) {
    if (e.status !== 404) throw e
  }
  if (!existing && proposal.operation === 'UPDATE')
    throw fail(404, 'IFLOW_NOT_FOUND', `iFlow '${spec.id}' no longer exists, so it cannot be updated. Ask the assistant for a new iFlow instead.`)
  if (existing && existing.packageId !== spec.packageId)
    throw fail(409, 'IFLOW_EXISTS_ELSEWHERE', `An iFlow '${spec.id}' already exists in package '${existing.packageId}'; it is not overwritten. Choose a different id.`)

  const details = { packageId: spec.packageId, proposal: proposal.ID }
  if (existing) {
    await audited(req, { action: 'UPDATE_IFLOW', targetType: 'Iflow', targetId: spec.id, details }, () => cpi.updateIflowContent(spec.id, { name: spec.name, zipBase64 }))
    return `Updated existing ${spec.id} in ${spec.packageId}`
  }
  await audited(req, { action: 'CREATE_IFLOW', targetType: 'Iflow', targetId: spec.id, details }, () =>
    cpi.createIflow({ id: spec.id, name: spec.name, packageId: spec.packageId, zipBase64 })
  )
  return `Created ${spec.id} in ${spec.packageId}`
}

/**
 * Polls the deploy task and the runtime artifact (every 5s, up to 2 min).
 * Fails only on a real error (task FAIL or runtime ERROR); if CPI is merely slow,
 * returns { pending: true } with the last status.
 * @returns {Promise<{ status: string, pending: boolean }>}
 */
async function waitForRuntime(iflowId, taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let last = 'NOT_DEPLOYED'
  let task = null
  const runtimeError = async () => (await cpi.getRuntimeError(iflowId).catch(() => null))?.message
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    if (taskId && task !== 'SUCCESS') {
      task = await cpi.getDeployStatus(taskId).catch(() => task)
      if (task === 'FAIL') throw fail(502, 'DEPLOY_ERROR', `Deployment failed: ${(await runtimeError()) || 'CPI reported the build/deploy task as FAIL. Open the iFlow in the CPI web editor to see the problem.'}`)
    }
    const rt = await cpi.getRuntimeArtifact(iflowId, { noCache: true })
    last = rt?.status || (task && task !== 'SUCCESS' ? task : 'NOT_DEPLOYED')
    if (rt?.status === 'STARTED') return { status: 'STARTED', pending: false }
    if (rt?.status === 'ERROR') throw fail(502, 'DEPLOY_ERROR', `Deployment failed: ${(await runtimeError()) || 'no error details from CPI'}`)
  }
  return { status: last, pending: true }
}

module.exports = { approve, retry, reject, setPackage, recoverInterrupted, listBackups, restoreBackup, nextVersion, INTERRUPTED }
