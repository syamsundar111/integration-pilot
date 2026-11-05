/**
 * Sender adapters the spec holds besides HTTPS (phase 5), the ProcessDirect, SFTP and OData V2 receivers (phase 6), and the settings the
 * builder writes fixed from their templates. Import and update keep an iFlow's sender only when the spec can hold it exactly: every fixed setting as
 * the template has it, and a parameter only where the spec holds one (SFTP: host, directory, file name, credential
 * name, archive directory); else Import makes it an HTTPS sender with a note, and an update is blocked. The receivers
 * the same way: else Import makes a placeholder step.
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
  sftpSender: Object.fromEntries(Object.entries(fixed('messageflow-sftp-sender.xml')).filter(([key]) => key !== 'scheduleKey')),
  // the ProcessDirect receiver (Ref_Receiver_ProcessDirect), the other end of a ProcessDirect sender
  processDirectReceiver: fixed('messageflow-processdirect-receiver.xml'),
  // the SFTP receiver of a Send step (Ref_Receiver_SFTP): proxy, existing-file handling, reconnects and the rest
  sftpReceiver: fixed('messageflow-sftp-receiver.xml'),
  // the OData V2 receiver of a Request Reply (Ref_Receiver_OData): timeout, CSRF, content type, paging, batch, retry, ...
  odataReceiver: fixed('messageflow-odata-receiver.xml')
}
const definitions = require('./spec-schema.json').definitions
const ADDRESS = new RegExp(definitions.soapSender.properties.address.pattern)
const QUEUE = new RegExp(definitions.jmsSender.properties.queue.pattern)
const PD_RECEIVER_ADDRESS = new RegExp(definitions.processDirectReceiver.properties.address.pattern)

// SFTP sender: spec values <-> stored, and the one schedule the template holds (every 15 minutes, all day, Etc/GMT)
const SFTP_AUTHENTICATION = { publicKey: 'public_key', userPassword: 'user_password' }
const SFTP_POST_PROCESSING = { delete: 'delete', move: 'move' }
const unescape = (v) => String(v || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const scheduleOf = (scheduleKey) => unescape(unescape(scheduleKey).match(/<row><cell>schedule1<\/cell><cell>([^<]*)<\/cell><\/row>/)?.[1])
const SFTP_SCHEDULE = scheduleOf(fs.readFileSync(path.join(__dirname, 'templates', 'iflw', 'messageflow-sftp-sender.xml'), 'utf8').match(/<key>scheduleKey<\/key>\s*<value>([^<]*)<\/value>/)[1])
const SFTP_MINUTES = Number(SFTP_SCHEDULE.match(/^0\+0\/(\d+)\+/)[1])

// OData V2 receiver: spec values <-> stored (the authentication is stored without spaces, unlike the HTTP receiver's)
const ODATA_AUTHENTICATION = { Basic: 'Basic', 'OAuth2 Client Credentials': 'OAuth2ClientCredentials' }
const ODATA_PROXY = { Internet: 'default', 'On-Premise': 'sapcc' }
const ODATA_OPERATION = { query: 'Query(GET)', create: 'Create(POST)' }

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

/**
 * An OData V2 receiver (a Request Reply's) as the spec holds it: its fixed settings, the authentication, proxy and
 * operation, and the fields (a whole {{Param}} only in the address, credential name and location ID)
 * @returns {{ call: object } | { differences: string[] }} call: the requestReplyOData fields besides type, name and system
 */
function odataReceiverOf(adapter) {
  const s = adapter?.settings || {}
  const differences = fixedDifferences('odataReceiver', s)
  const fromCpi = (map, stored, label) => {
    const value = Object.keys(map).find((k) => map[k] === stored)
    if (!value) differences.push(/\{\{/.test(stored || '') ? `the ${label} is the parameter ${stored}` : `the ${label} is '${stored || ''}' (the builder writes ${Object.values(map).join(' or ')})`)
    return value
  }
  const authType = fromCpi(ODATA_AUTHENTICATION, s.authenticationMethod, 'authentication')
  const proxyType = fromCpi(ODATA_PROXY, s.proxyType, 'proxy type')
  const operation = fromCpi(ODATA_OPERATION, s.operation, 'operation')
  const props = definitions.requestReplyOData.properties
  const call = { url: '', operation, resourcePath: '', authType, credentialName: '', proxyType }
  const fields = [
    ['url', 'address', 'address'],
    ['resourcePath', 'resourcePath', 'resource path'],
    ['credentialName', 'alias', 'credential name'],
    ...(proxyType === 'On-Premise' && s.scc_location_id ? [['locationId', 'scc_location_id', 'location ID']] : []),
    ...(operation === 'query' && s.queryOptions ? [['queryOptions', 'queryOptions', 'query options']] : [])
  ]
  for (const [field, key, label] of fields) {
    const value = String(s[key] ?? '')
    if (!new RegExp(props[field].pattern).test(value))
      differences.push(/\{\{/.test(value) ? `the ${label} is ${value}, which the spec cannot hold as a parameter` : `the ${label} '${value}' is not a value the spec allows`)
    call[field] = value
  }
  // set in CPI but not used by the chosen proxy type or operation: an update would drop them
  if (proxyType === 'Internet' && s.scc_location_id) differences.push(`the location ID '${s.scc_location_id}' is set with proxy type Internet`)
  if (operation === 'create' && s.queryOptions) differences.push(`the query options '${s.queryOptions}' are set with Create(POST)`)
  if (differences.length) return { differences }
  // in the order of the spec's fields
  const { url, resourcePath, queryOptions, credentialName, locationId } = call
  return { call: { url, operation, resourcePath, ...(queryOptions && { queryOptions }), authType, credentialName, proxyType, ...(locationId && { locationId }) } }
}

/**
 * An SFTP receiver (a Send step's) as the spec holds it: its fixed settings, and the fields of its authentication (a
 * whole {{Param}} only where the spec allows one)
 * @returns {{ call: object } | { differences: string[] }} call: the sendSftp fields besides type, name and system
 */
function sftpReceiverOf(adapter) {
  const s = adapter?.settings || {}
  const differences = fixedDifferences('sftpReceiver', s)
  const authentication = Object.keys(SFTP_AUTHENTICATION).find((k) => SFTP_AUTHENTICATION[k] === s.authentication)
  if (!authentication)
    differences.push(/\{\{/.test(s.authentication || '') ? `the authentication is the parameter ${s.authentication}` : `the authentication is '${s.authentication || ''}' (the builder writes ${Object.values(SFTP_AUTHENTICATION).join(' or ')})`)
  // the fields of the variant only: hidden fields of the other variant are not used by CPI
  const fields = [
    ['host', 'host', 'host'],
    ['directory', 'path', 'directory'],
    ['fileName', 'fileName', 'file name'],
    ...(authentication === 'publicKey' ? [['username', 'username', 'user name'], ['privateKeyAlias', 'privateKeyAlias', 'private key alias']] : []),
    ...(authentication === 'userPassword' ? [['credentialName', 'credential_name', 'credential name']] : [])
  ]
  const call = { host: '', directory: '', fileName: '', authentication }
  for (const [field, key, label] of fields) {
    const value = String(s[key] ?? '')
    if (!new RegExp(definitions.sendSftp.properties[field].pattern).test(value))
      differences.push(/\{\{/.test(value) ? `the ${label} is ${value}, which the spec cannot hold as a parameter` : `the ${label} '${value}' is not a value the spec allows`)
    call[field] = value
  }
  return differences.length ? { differences } : { call }
}

/**
 * A ProcessDirect receiver (a Request Reply's or the Message End's) as the spec holds it: its address, a path or a
 * whole {{Param}}
 * @returns {{ address: string } | { differences: string[] }}
 */
function processDirectReceiverOf(adapter) {
  const differences = fixedDifferences('processDirectReceiver', adapter?.settings || {})
  const address = String(adapter?.address ?? '')
  if (!PD_RECEIVER_ADDRESS.test(address)) differences.push(`the address '${address}' is not a path of letters, digits and - _ . ~ or a whole parameter`)
  return differences.length ? { differences } : { address }
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

module.exports = { triggerOf, processDirectReceiverOf, sftpReceiverOf, odataReceiverOf, ODATA_AUTHENTICATION, ODATA_PROXY, ODATA_OPERATION, FIXED, SFTP_AUTHENTICATION, SFTP_POST_PROCESSING, SFTP_MINUTES }
