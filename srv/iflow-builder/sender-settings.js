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
const FIXED = { soapSender: fixed('messageflow-soap-sender.xml'), processDirectSender: fixed('messageflow-processdirect-sender.xml'), jmsSender: fixed('messageflow-jms-sender.xml') }
const definitions = require('./spec-schema.json').definitions
const ADDRESS = new RegExp(definitions.soapSender.properties.address.pattern)
const QUEUE = new RegExp(definitions.jmsSender.properties.queue.pattern)

/**
 * The spec trigger for an iFlow's sender adapter (parser: adapters, with settings).
 * @returns {{ trigger: object } | { differences: string[] } | null} null: no sender the spec holds besides HTTPS
 */
function triggerOf(adapter) {
  if (adapter?.direction !== 'Sender') return null
  if (adapter.type === 'SOAP' && adapter.settings?.MessageProtocol === 'SOAP 1.x') return check('soapSender', adapter, { type: 'soapSender', address: adapter.address })
  if (adapter.type === 'ProcessDirect') return check('processDirectSender', adapter, { type: 'processDirectSender', address: adapter.address })
  if (adapter.type === 'JMS') return check('jmsSender', adapter, { type: 'jmsSender', queue: adapter.settings?.QueueName_inbound })
  return null
}

function check(kind, adapter, trigger) {
  const s = adapter.settings || {}
  const differences = Object.entries(FIXED[kind])
    .filter(([key, value]) => key in s && String(s[key] ?? '') !== value) // older adapter versions lack some keys
    .map(([key, value]) => `${key} is '${s[key]}' (the builder writes '${value || '(empty)'}')`)
  // the field the spec holds: an address (a path), or a JMS queue name
  const [field, value, pattern, rule] = 'queue' in trigger ? ['queue name', trigger.queue, QUEUE, 'letters, digits and _ - . up to 80 characters'] : ['address', trigger.address, ADDRESS, 'a path of letters, digits and - _ . ~']
  if (/\{\{/.test(value || '')) differences.push(`the ${field} is the parameter ${value}`)
  else if (!pattern.test(value || '')) differences.push(`the ${field} '${value || ''}' is not ${rule}`)
  return differences.length ? { differences } : { trigger }
}

module.exports = { triggerOf, FIXED }
