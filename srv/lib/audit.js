/**
 * AuditLog helper: every write (UI actions, proposal approvals) is recorded,
 * successful or not.
 */
const cds = require('@sap/cds')

const LOG = cds.log('audit')

const toJson = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v))

/**
 * Writes one AuditLog entry in its own transaction, so failed requests
 * (whose transaction is rolled back) are still recorded. Never throws.
 */
async function audit(req, { action, targetType, targetId, status, details }) {
  const user = req?.user?.id || cds.context?.user?.id || 'unknown'
  try {
    await cds.tx({ user: req?.user, tenant: req?.tenant }, (tx) =>
      tx.run(
        INSERT.into('iflowpilot.AuditLog').entries({ action, targetType, targetId, status, details: toJson(details), user })
      )
    )
  } catch (e) {
    LOG.error('Failed to write audit log entry', { action, targetId }, e)
  }
}

/**
 * Runs a write operation and records its outcome.
 * @param {object} meta - { action, targetType, targetId, details? }
 * @param {Function} fn - the write; its result is returned
 */
async function audited(req, meta, fn) {
  try {
    const result = await fn()
    await audit(req, { ...meta, status: 'SUCCESS' })
    return result
  } catch (e) {
    await audit(req, { ...meta, status: 'FAILED', details: { ...meta.details, error: { code: e.code, message: e.message } } })
    throw e
  }
}

module.exports = { audit, audited }
