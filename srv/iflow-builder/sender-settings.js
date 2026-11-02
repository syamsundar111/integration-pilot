/**
 * Sender adapters the spec holds besides HTTPS (phase 5), and the settings the builder writes fixed from their
 * templates. Import and update keep an iFlow's sender only when the spec can hold it exactly: every fixed setting as
 * the template has it, and a parameter only where the spec holds one (SFTP: host, directory, file name, credential
 * name, archive directory); else Import makes it an HTTPS sender with a note, and an update is blocked.
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
const FIXED = {
  soapSender: fixed('messageflow-soap-sender.xml'),
  processDirectSender: fixed('messageflow-processdirect-sender.xml'),
  jmsSender: fixed('messageflow-jms-sender.xml'),
  // the scheduler is compared by its schedule1 (the other rows are the editor's state)
  sftpSender: Object.fromEntries(Object.entries(fixed('messageflow-sftp-sender.xml')).filter(([key]) => key !== 'scheduleKey'))
}
const definitions = require('./spec-schema.json').definitions
const ADDRESS = new RegExp(definitions.soapSender.properties.address.pattern)
const QUEUE = new RegExp(definitions.jmsSender.properties.queue.pattern)

// SFTP sender: spec values <-> stored, and the one schedule the template holds (every 15 minutes, all day, Etc/GMT)
const SFTP_AUTHENTICATION = { publicKey: 'public_key', userPassword: 'user_password' }
const SFTP_POST_PROCESSING = { delete: 'delete', move: 'move' }
const unescape = (v) => String(v || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const scheduleOf = (scheduleKey) => unescape(unescape(scheduleKey).match(/<row><cell>schedule1<\/cell><cell>([^<]*)<\/cell><\/row>/)?.[1])
const SFTP_SCHEDULE = scheduleOf(fs.readFileSync(path.join(__dirname, 'templates', 'iflw', 'messageflow-sftp-sender.xml'), 'utf8').match(/<key>scheduleKey<\/key>\s*<value>([^<]*)<\/value>/)[1])
const SFTP_MINUTES = Number(SFTP_SCHEDULE.match(/^0\+0\/(\d+)\+/)[1])

/**
 * The spec trigger for an iFlow's sender adapter (parser: adapters, with settings).
 * @returns {{ trigger: object } | { differences: string[] } | null} null: no sender the spec holds besides HTTPS
 */
function triggerOf(adapter) {
  if (adapter?.direction !== 'Sender') return null
  if (adapter.type === 'SOAP' && adapter.settings?.MessageProtocol === 'SOAP 1.x') return check('soapSender', adapter, { type: 'soapSender', address: adapter.address })
  if (adapter.type === 'ProcessDirect') return check('processDirectSender', adapter, { type: 'processDirectSender', address: adapter.address })
  if (adapter.type === 'JMS') return check('jmsSender', adapter, { type: 'jmsSender', queue: adapter.settings?.QueueName_inbound })
  if (adapter.type === 'SFTP') return sftp(adapter)
  return null
}

/** An SFTP sender: its fixed settings, the variant fields (a whole {{Param}} only where the spec allows one) and the schedule */
function sftp(adapter) {
  const s = adapter.settings || {}
  const differences = fixedDifferences('sftpSender', s)
  const fromCpi = (map, stored, label) => {
    const value = Object.keys(map).find((k) => map[k] === stored)
    if (!value) differences.push(/\{\{/.test(stored || '') ? `the ${label} is the parameter ${stored}` : `the ${label} is '${stored || ''}' (the builder writes ${Object.values(map).join(' or ')})`)
    return value
  }
  const authentication = fromCpi(SFTP_AUTHENTICATION, s.authentication, 'authentication')
  const postProcessing = fromCpi(SFTP_POST_PROCESSING, s.noop, 'post-processing')
  const schedule = scheduleOf(s.scheduleKey)
  if (schedule !== SFTP_SCHEDULE) differences.push(/\{\{/.test(s.scheduleKey || '') ? 'the scheduler is a parameter' : `the schedule is '${schedule}' (the builder writes every ${SFTP_MINUTES} minutes, all day, Etc/GMT)`)
  // the fields of the variant only: hidden fields of the other variant are not used by CPI
  const fields = [
    ['host', 'host', 'host'],
    ['directory', 'path', 'directory'],
    ['fileName', 'fileName', 'file name'],
    ...(authentication === 'publicKey' ? [['username', 'username', 'user name'], ['privateKeyAlias', 'privateKeyAlias', 'private key alias']] : []),
    ...(authentication === 'userPassword' ? [['credentialName', 'credential_name', 'credential name']] : []),
    ...(postProcessing === 'move' ? [['archiveDirectory', 'file.move', 'archive directory']] : [])
  ]
  const trigger = { type: 'sftpSender' }
  for (const [field, key, label] of fields) {
    const value = String(s[key] ?? '')
    if (!new RegExp(definitions.sftpSender.properties[field].pattern).test(value))
      differences.push(/\{\{/.test(value) ? `the ${label} is ${value}, which the spec cannot hold as a parameter` : `the ${label} '${value}' is not a value the spec allows`)
    trigger[field] = value
  }
  if (differences.length) return { differences }
  const { host, directory, fileName, username, privateKeyAlias, credentialName, archiveDirectory } = trigger
  return {
    trigger: {
      type: 'sftpSender',
      host,
      directory,
      fileName,
      authentication,
      ...(authentication === 'publicKey' ? { username, privateKeyAlias } : { credentialName }),
      postProcessing,
      ...(postProcessing === 'move' && { archiveDirectory }),
      minutes: SFTP_MINUTES
    }
  }
}

function fixedDifferences(kind, s) {
  return Object.entries(FIXED[kind])
    .filter(([key, value]) => key in s && String(s[key] ?? '') !== value) // older adapter versions lack some keys
    .map(([key, value]) => `${key} is '${s[key]}' (the builder writes '${value || '(empty)'}')`)
}

function check(kind, adapter, trigger) {
  const differences = fixedDifferences(kind, adapter.settings || {})
  // the field the spec holds: an address (a path), or a JMS queue name
  const [field, value, pattern, rule] = 'queue' in trigger ? ['queue name', trigger.queue, QUEUE, 'letters, digits and _ - . up to 80 characters'] : ['address', trigger.address, ADDRESS, 'a path of letters, digits and - _ . ~']
  if (/\{\{/.test(value || '')) differences.push(`the ${field} is the parameter ${value}`)
  else if (!pattern.test(value || '')) differences.push(`the ${field} '${value || ''}' is not ${rule}`)
  return differences.length ? { differences } : { trigger }
}

module.exports = { triggerOf, FIXED, SFTP_AUTHENTICATION, SFTP_POST_PROCESSING, SFTP_MINUTES }
