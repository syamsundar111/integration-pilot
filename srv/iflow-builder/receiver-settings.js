/**
 * HTTP receiver settings: authentication, proxy and timeout. The spec uses the labels of the CPI editor
 * (proxyType "On-Premise"); CPI stores other values (proxyType "sapcc"). The values are the ones in the
 * reference exports (templates/reference-values.json); credentials are names of deployed security
 * material only, never secrets.
 */
const { checkValues } = require('./cpi-values')

const AUTH_TYPES = ['None', 'Basic', 'OAuth2 Client Credentials'] // stored as they are
const PROXY_TYPES = { Internet: 'default', 'On-Premise': 'sapcc' } // spec value -> stored value
const DEFAULT_TIMEOUT = 60000 // ms, as in the reference exports
const ADAPTER = 'HTTP Receiver' // the key in reference-values.json

/** Spec settings of a requestReplyHttp step or httpReceiver end -> the stored CPI properties */
function toCpi(call) {
  const auth = call.authType || 'None'
  const proxy = call.proxyType || 'Internet'
  return {
    authenticationMethod: auth,
    credentialName: auth === 'None' ? '' : call.credentialName || '',
    proxyType: PROXY_TYPES[proxy],
    locationID: proxy === 'On-Premise' ? call.locationId || '' : '',
    httpRequestTimeout: String(call.timeout ?? DEFAULT_TIMEOUT)
  }
}

/**
 * Parsed adapter settings (CPI properties) -> spec settings; unsupported: what the spec cannot hold
 * (e.g. another authentication method, a manual proxy), so the caller can refuse or note it.
 * Defaults (None, Internet, 60000) are left out, as a spec written by hand would.
 * @returns {{ settings: object, unsupported: string[] }}
 */
function fromCpi(p = {}) {
  const settings = {}
  const unsupported = []
  const auth = p.authenticationMethod || 'None'
  if (!AUTH_TYPES.includes(auth)) unsupported.push(`authentication '${auth}'`)
  else if (auth !== 'None') Object.assign(settings, { authType: auth, credentialName: p.credentialName || '' })
  const proxy = Object.keys(PROXY_TYPES).find((k) => PROXY_TYPES[k] === (p.proxyType || 'default'))
  if (!proxy) unsupported.push(`proxy type '${p.proxyType}'`)
  else if (proxy !== 'Internet') Object.assign(settings, { proxyType: proxy, ...(p.locationID && { locationId: p.locationID }) })
  const timeout = Number(p.httpRequestTimeout || DEFAULT_TIMEOUT)
  if (!Number.isInteger(timeout) || timeout < 1) unsupported.push(`timeout '${p.httpRequestTimeout}'`)
  else if (timeout !== DEFAULT_TIMEOUT) settings.timeout = timeout
  return { settings, unsupported }
}

/**
 * The stored values of a call checked against the reference exports (cpi-values.js): { errors, warnings }
 * @param {object} [values] - reference-values.json, for tests
 */
function checkAgainstReferences(call, where, values) {
  const stored = toCpi(call)
  return checkValues(ADAPTER, [['authenticationMethod', stored.authenticationMethod], ['proxyType', stored.proxyType]], where, values)
}

module.exports = { AUTH_TYPES, PROXY_TYPES, DEFAULT_TIMEOUT, toCpi, fromCpi, checkAgainstReferences }
