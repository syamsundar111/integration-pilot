/**
 * Sender adapters the spec holds besides HTTPS (phase 5), and the settings the builder writes fixed from their
 * templates. Import and update keep an iFlow's sender only when the spec can hold it exactly: every fixed setting as
 * the template has it, and no parameter where the spec holds a value; else Import makes it an HTTPS sender with a
 * note, and an update is blocked.
 */
const fs = require('fs')
const path = require('path')

// versions and names differ by adapter release and do not change behaviour; address and system are spec fields
const NOT_SETTINGS = ['componentVersion', 'cmdVariantUri', 'ComponentNS', 'ComponentSWCVId', 'ComponentSWCVName', 'TransportProtocolVersion', 'MessageProtocolVersion', 'Name', 'Description']
const fixed = (file) =>
  Object.fromEntries(
    [...fs.readFileSync(path.join(__dirname, 'templates', 'iflw', file), 'utf8').matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)]
      .filter((m) => !NOT_SETTINGS.includes(m[1]))
      .map((m) => [m[1], m[2] ?? ''])
  )
const FIXED = { soapSender: fixed('messageflow-soap-sender.xml') }
const ADDRESS = new RegExp(require('./spec-schema.json').definitions.soapSender.properties.address.pattern)

/**
 * The spec trigger for an iFlow's sender adapter (parser: adapters, with settings).
 * @returns {{ trigger: object } | { differences: string[] } | null} null: no sender the spec holds besides HTTPS
 */
function triggerOf(adapter) {
  if (adapter?.direction !== 'Sender') return null
  if (adapter.type === 'SOAP' && adapter.settings?.MessageProtocol === 'SOAP 1.x') return check('soapSender', adapter, { type: 'soapSender', address: adapter.address })
  return null
}

function check(kind, adapter, trigger) {
  const s = adapter.settings || {}
  const differences = Object.entries(FIXED[kind])
    .filter(([key, value]) => key in s && String(s[key] ?? '') !== value) // older adapter versions lack some keys
    .map(([key, value]) => `${key} is '${s[key]}' (the builder writes '${value || '(empty)'}')`)
  if (/\{\{/.test(trigger.address || '')) differences.push(`the address is the parameter ${trigger.address}`)
  else if (!ADDRESS.test(trigger.address || '')) differences.push(`the address '${trigger.address || ''}' is not a path of letters, digits and - _ . ~`)
  return differences.length ? { differences } : { trigger }
}

module.exports = { triggerOf, FIXED }
