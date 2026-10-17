/**
 * Local authentication for the development and hybrid profiles: every request runs as
 * one fixed user with the Admin role, so `@requires: 'Admin'` works without a login
 * prompt. Production uses XSUAA (see package.json "[production]" and xs-security.json).
 */
const cds = require('@sap/cds')

const user = new cds.User({ id: process.env.DEV_USER || 'local-dev', roles: ['Admin'] })

module.exports = function dev_auth(req, _res, next) {
  cds.context.user = req.user = user
  next()
}
