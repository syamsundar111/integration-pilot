/**
 * Local authentication for the development and hybrid profiles: every request runs as
 * one fixed user with the Admin role, so `@requires: 'Admin'` works without a login
 * prompt. Production uses XSUAA (see package.json "[production]" and xs-security.json).
 */
const cds = require('@sap/cds')

const user = new cds.User({ id: process.env.DEV_USER || 'local-dev', roles: ['Admin'] })

module.exports = function dev_auth(req, _res, next) {
  // tests only (NODE_ENV=test): a second user via the x-test-user header, to test per-user access
  const testUser = process.env.NODE_ENV === 'test' && req.headers['x-test-user']
  cds.context.user = req.user = testUser ? new cds.User({ id: String(testUser), roles: ['Admin'] }) : user
  next()
}
