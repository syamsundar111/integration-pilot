/**
 * SAP Cloud Integration (CPI) OData v2 API client.
 *
 * All calls go through the BTP destination CPI_API (OAuth2ClientCredentials,
 * Process Integration Runtime plan `api`). The destination URL must be the tenant
 * host only (https://<tenant>.it-cpi<xx>.cfapps.<region>.hana.ondemand.com);
 * the /api/v1 base path is added here.
 *
 * Returned objects are normalized to camelCase. Errors are thrown as
 * Error { status, code, message, hint }.
 */
const cds = require('@sap/cds')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const { getDestination } = require('@sap-cloud-sdk/connectivity')

const LOG = cds.log('cpi')

const DESTINATION = 'CPI_API'
const BASE_PATH = '/api/v1'
const TIMEOUT_MS = 60_000
const CACHE_TTL_MS = 30_000

const MESSAGE_STATUSES = ['COMPLETED', 'FAILED', 'PROCESSING', 'RETRY', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED']
const BINARY_RESOURCE_TYPES = ['jar', 'archive']

const DESTINATION_HINT =
  `Check destination ${DESTINATION} (URL = tenant host, OAuth2ClientCredentials with the api-plan service key). ` +
  'Locally, bind the destination service (cds bind -2 iflowpilot-dest) and run with --profile hybrid.'

// --- URL helpers -------------------------------------------------------------

/** OData v2 string literal: single quotes doubled, then URL-encoded */
const lit = (value) => `'${encodeURIComponent(String(value).replace(/'/g, "''"))}'`
const packagePath = (id) => `/IntegrationPackages(${lit(id)})`
// Design-time artifacts are always addressed in their 'active' (latest saved) version
const iflowPath = (id) => `/IntegrationDesigntimeArtifacts(Id=${lit(id)},Version='active')`
const runtimePath = (id) => `/IntegrationRuntimeArtifacts(${lit(id)})`

// --- Read cache (30s, cleared on every write) -------------------------------

const cache = new Map()

async function cached(key, fn) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const value = await fn()
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS })
  return value
}

function invalidateCache() {
  cache.clear()
}

// --- HTTP core ---------------------------------------------------------------

function send({ method = 'GET', path, data, headers = {}, binary = false }) {
  return executeHttpRequest(
    { destinationName: DESTINATION },
    {
      method,
      url: BASE_PATH + path,
      data,
      timeout: TIMEOUT_MS,
      headers: { Accept: binary ? '*/*' : 'application/json', ...headers },
      ...(binary && { responseType: 'arraybuffer' })
    },
    // OAuth client-credential calls normally need no CSRF token; we only fetch one if CPI asks (see below)
    { fetchCsrfToken: false }
  )
}

/** Fetches a CSRF token plus the session cookies it is bound to. */
async function fetchCsrf() {
  const res = await send({ path: '/', headers: { 'x-csrf-token': 'Fetch' } })
  const token = res.headers['x-csrf-token']
  const cookie = [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
  return { token, cookie }
}

/**
 * Executes a request with error normalization and a CSRF fallback:
 * if a write is rejected with 403 + `x-csrf-token: required`, fetch a token and retry once.
 * @param {object} opts - { method, path, data, headers, binary, role }
 *   role: the api-plan role this call needs, used in the 403 hint
 */
async function request(opts) {
  const isWrite = opts.method && opts.method !== 'GET'
  try {
    try {
      return await send(opts)
    } catch (e) {
      const csrfRequired = /required/i.test(e.response?.headers?.['x-csrf-token'] || '')
      if (!(isWrite && e.response?.status === 403 && csrfRequired)) throw e
      LOG.debug('CSRF token required, fetching one and retrying', opts.method, opts.path)
      const { token, cookie } = await fetchCsrf()
      return await send({ ...opts, headers: { ...opts.headers, 'x-csrf-token': token, ...(cookie && { Cookie: cookie }) } })
    }
  } catch (e) {
    const err = normalizeError(e, opts)
    // 404 is often expected (existence checks, undeployed artifacts), so keep it out of the warnings
    LOG[err.status === 404 ? 'debug' : 'warn'](`${opts.method || 'GET'} ${opts.path} failed:`, err.status, err.code, err.message)
    throw err
  } finally {
    if (isWrite) invalidateCache()
  }
}

/** GET returning parsed OData JSON, cached for 30s unless noCache is set */
function get(path, { role = 'WorkspacePackagesRead', noCache = false } = {}) {
  const run = () => request({ path, role }).then((res) => res.data)
  return noCache ? run() : cached(path, run)
}

const results = (data) => data?.d?.results ?? (Array.isArray(data?.d) ? data.d : [])
const entity = (data) => data?.d ?? data

// --- Errors ------------------------------------------------------------------

function cpiError(status, code, message, hint) {
  const err = new Error(message)
  Object.assign(err, { status, code, hint })
  Object.defineProperty(err, 'isCpiError', { value: true }) // non-enumerable: not serialized into responses
  err.$sanitize = false // our messages are safe to show; don't mask 5xx in production
  return err
}

/** Pulls the human-readable message out of an OData v2 error (JSON or XML) */
function extractMessage(data) {
  if (data == null) return null
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) data = Buffer.from(data).toString('utf8')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      const xml = /<message[^>]*>([^<]+)<\/message>/i.exec(data)
      if (xml) return xml[1].trim()
      return /^\s*</.test(data) ? null : data.trim().slice(0, 500) || null // ignore HTML error pages
    }
  }
  const msg = data?.error?.message
  return (typeof msg === 'object' ? msg?.value : msg) || data?.message || null
}

/** Collects all messages of an error chain (Cloud SDK wraps root causes) */
function errorChain(e) {
  const msgs = []
  for (let c = e; c && msgs.length < 5; c = c.cause) if (c.message) msgs.push(c.message)
  return msgs.join(' — ')
}

function normalizeError(e, { role } = {}) {
  if (e.isCpiError) return e
  const status = e.response?.status

  // No HTTP response: destination lookup, token fetch or network problem
  if (!status) {
    const chain = errorChain(e)
    if (e.code === 'ECONNABORTED' || /timeout/i.test(chain))
      return cpiError(504, 'CPI_TIMEOUT', `CPI did not respond within ${TIMEOUT_MS / 1000}s.`, 'Retry later; check the tenant status.')
    if (/destination|service binding|VCAP|token/i.test(chain)) return cpiError(502, 'DESTINATION_ERROR', chain, DESTINATION_HINT)
    return cpiError(502, 'CPI_UNREACHABLE', chain || 'CPI is unreachable.', `Check the URL of destination ${DESTINATION}.`)
  }

  const message = extractMessage(e.response.data) || `CPI responded with HTTP ${status}.`
  if (/draft state/i.test(message))
    return cpiError(409, 'CPI_DRAFT_ARTIFACTS', message, 'Open these iFlows in the CPI web editor and save them as a version (or discard the draft), then try again.')
  if (/lock/i.test(message))
    return cpiError(409, 'CPI_LOCKED', message, 'Close the iFlow in the CPI web editor (or cancel checkout) and retry.')

  switch (status) {
    case 400:
      return cpiError(400, 'CPI_BAD_REQUEST', message)
    case 401:
      // not passed through as 401, which would trigger an auth challenge for our own app
      return cpiError(502, 'CPI_UNAUTHORIZED', message,
        `CPI rejected the credentials of destination ${DESTINATION}. Check client id/secret and token URL of the Process Integration Runtime 'api' service key.`)
    case 403:
      return cpiError(403, 'CPI_FORBIDDEN', message,
        `Likely missing role ${role || 'WorkspacePackagesEdit'} on the Process Integration Runtime 'api' plan instance. Add it to the instance's roles and recreate the service key.`)
    case 404:
      return cpiError(404, 'CPI_NOT_FOUND', message, 'Not found on the tenant. Ids are case-sensitive.')
    case 409:
      return cpiError(409, 'CPI_CONFLICT', message, /already exist/i.test(message) ? 'An object with this id already exists on the tenant. Choose a different id.' : undefined)
    case 501:
      return cpiError(502, 'CPI_NOT_SUPPORTED', message, 'The CPI API does not support this operation or query option.')
    default:
      return cpiError(502, 'CPI_ERROR', message, status >= 500 ? 'CPI reported an internal error; check the tenant and retry.' : undefined)
  }
}

// --- Mappers (OData v2 -> camelCase) ----------------------------------------

/** CPI mixes '/Date(ms)/' and plain millisecond strings */
function toIso(v) {
  if (v == null || v === '') return null
  const m = /\/Date\((-?\d+)/.exec(v)
  if (m) return new Date(Number(m[1])).toISOString()
  if (/^\d{10,}$/.test(v)) return new Date(Number(v)).toISOString()
  return v
}

const mapPackage = (p) => ({
  id: p.Id,
  name: p.Name,
  shortText: p.ShortText,
  description: p.Description,
  version: p.Version,
  vendor: p.Vendor,
  mode: p.Mode,
  partnerContent: p.PartnerContent,
  createdBy: p.CreatedBy,
  createdAt: toIso(p.CreationDate),
  modifiedBy: p.ModifiedBy,
  modifiedAt: toIso(p.ModifiedDate)
})

const mapIflow = (a) => ({
  id: a.Id,
  version: a.Version,
  packageId: a.PackageId,
  name: a.Name,
  description: a.Description,
  sender: a.Sender,
  receiver: a.Receiver,
  createdBy: a.CreatedBy,
  createdAt: toIso(a.CreatedAt),
  modifiedBy: a.ModifiedBy,
  modifiedAt: toIso(a.ModifiedAt)
})

const mapRuntime = (r) => ({
  id: r.Id,
  version: r.Version,
  name: r.Name,
  type: r.Type,
  status: r.Status,
  deployedBy: r.DeployedBy,
  deployedOn: toIso(r.DeployedOn)
})

const mapConfiguration = (c) => ({ key: c.ParameterKey, value: c.ParameterValue, dataType: c.DataType })

const mapResource = (r) => ({ name: r.Name, type: r.ResourceType, referencedType: r.ReferencedResourceType || null })

const mapMessageLog = (m) => ({
  messageGuid: m.MessageGuid,
  correlationId: m.CorrelationId,
  applicationMessageId: m.ApplicationMessageId,
  integrationFlowName: m.IntegrationFlowName,
  iflowId: m.IntegrationArtifact?.Id,
  packageId: m.IntegrationArtifact?.PackageId,
  packageName: m.IntegrationArtifact?.PackageName,
  status: m.Status,
  customStatus: m.CustomStatus,
  logLevel: m.LogLevel,
  sender: m.Sender,
  receiver: m.Receiver,
  logStart: toIso(m.LogStart),
  logEnd: toIso(m.LogEnd)
})

// --- Packages ----------------------------------------------------------------

async function listPackages() {
  return results(await get('/IntegrationPackages')).map(mapPackage)
}

async function getPackage(id) {
  return mapPackage(entity(await get(packagePath(id))))
}

async function createPackage({ id, name, shortText, description, version }) {
  await request({
    method: 'POST',
    path: '/IntegrationPackages',
    role: 'WorkspacePackagesEdit',
    data: {
      Id: id,
      Name: name,
      ShortText: shortText || name, // mandatory in CPI
      Description: description || '',
      Version: version || '1.0.0',
      SupportedPlatform: 'SAP Cloud Integration'
    }
  })
  return getPackage(id)
}

async function updatePackage(id, changes) {
  // PUT replaces the entity, so merge with the current values first
  const current = await getPackage(id)
  const next = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) }
  await request({
    method: 'PUT',
    path: packagePath(id),
    role: 'WorkspacePackagesEdit',
    data: { Name: next.name, ShortText: next.shortText || next.name, Description: next.description || '', Version: next.version }
  })
  return getPackage(id)
}

async function deletePackage(id) {
  await request({ method: 'DELETE', path: packagePath(id), role: 'WorkspacePackagesEdit' })
}

/** @returns {Promise<Buffer>} package export zip */
async function downloadPackageZip(id) {
  const res = await request({ path: `${packagePath(id)}/$value`, binary: true, role: 'WorkspacePackagesRead' })
  return Buffer.from(res.data)
}

// --- iFlows ------------------------------------------------------------------

async function listIflows(packageId) {
  return results(await get(`${packagePath(packageId)}/IntegrationDesigntimeArtifacts`)).map(mapIflow)
}

async function getIflow(id) {
  return mapIflow(entity(await get(iflowPath(id))))
}

/** @returns {Promise<Buffer>} iFlow zip */
async function downloadIflowZip(id) {
  const res = await request({ path: `${iflowPath(id)}/$value`, binary: true, role: 'WorkspacePackagesRead' })
  return Buffer.from(res.data)
}

/** Without zipBase64 CPI creates an empty iFlow */
async function createIflow({ id, name, packageId, zipBase64 }) {
  await request({
    method: 'POST',
    path: '/IntegrationDesigntimeArtifacts',
    role: 'WorkspacePackagesEdit',
    data: { Id: id, Name: name, PackageId: packageId, ...(zipBase64 && { ArtifactContent: zipBase64 }) }
  })
  return getIflow(id)
}

/** Replaces the iFlow content (zip). CPI requires Name in the payload. */
async function updateIflowContent(id, { name, zipBase64 }) {
  if (!name) name = (await getIflow(id)).name
  await request({
    method: 'PUT',
    path: iflowPath(id),
    role: 'WorkspacePackagesEdit',
    data: { Name: name, ArtifactContent: zipBase64 }
  })
  return getIflow(id)
}

/** Saves the iFlow's current design-time content as a new CPI version (IntegrationDesigntimeArtifactSaveAsVersion) */
async function saveIflowAsVersion(id, version) {
  await request({
    method: 'POST',
    path: `/IntegrationDesigntimeArtifactSaveAsVersion?Id=${lit(id)}&SaveAsVersion=${lit(version)}`,
    role: 'WorkspacePackagesEdit'
  })
}

async function deleteIflow(id) {
  await request({ method: 'DELETE', path: iflowPath(id), role: 'WorkspacePackagesEdit' })
}

// --- Configurations (externalized parameters) -------------------------------

async function getConfigurations(id) {
  return results(await get(`${iflowPath(id)}/Configurations`)).map(mapConfiguration)
}

async function updateConfiguration(id, key, value, dataType = 'xsd:string') {
  await request({
    method: 'PUT',
    path: `${iflowPath(id)}/$links/Configurations(${lit(key)})`,
    role: 'WorkspacePackagesConfigure',
    data: { ParameterValue: String(value ?? ''), DataType: dataType }
  })
}

// --- Resources (scripts, mappings, schemas ...) -----------------------------

async function listResources(id) {
  return results(await get(`${iflowPath(id)}/Resources`)).map(mapResource)
}

const resourcePath = (id, name, type) => `${iflowPath(id)}/$links/Resources(Name=${lit(name)},ResourceType=${lit(type)})`

async function getResource(id, name, type) {
  const res = await request({ path: `${resourcePath(id, name, type)}/$value`, binary: true, role: 'WorkspacePackagesRead' })
  const buf = Buffer.from(res.data)
  const isBinary = BINARY_RESOURCE_TYPES.includes(String(type).toLowerCase())
  return { name, type, content: isBinary ? null : buf.toString('utf8'), contentBase64: buf.toString('base64') }
}

/** Creates the resource or replaces its content if it already exists */
async function upsertResource(id, name, type, base64) {
  const exists = (await listResources(id)).some((r) => r.name === name && r.type === type)
  if (exists) {
    await request({ method: 'PUT', path: resourcePath(id, name, type), role: 'WorkspacePackagesEdit', data: { ResourceContent: base64 } })
  } else {
    await request({
      method: 'POST',
      path: `${iflowPath(id)}/Resources`,
      role: 'WorkspacePackagesEdit',
      data: { Name: name, ResourceType: type, ResourceContent: base64 }
    })
  }
}

// --- Runtime -----------------------------------------------------------------

/** Triggers an async deployment of the active version. @returns {{ taskId }} */
async function deployIflow(id) {
  const res = await request({
    method: 'POST',
    path: `/DeployIntegrationDesigntimeArtifact?Id=${lit(id)}&Version='active'`,
    role: 'WorkspaceArtifactsDeploy'
  })
  const taskId = typeof res.data === 'string' ? res.data.trim() : entity(res.data)?.TaskId || null
  return { taskId }
}

/**
 * Status of a deploy task from deployIflow(): BUILDING | DEPLOYING | SUCCESS | FAIL.
 * SUCCESS means CPI accepted the build; the runtime artifact can appear later.
 */
async function getDeployStatus(taskId) {
  const data = await get(`/BuildAndDeployStatus(TaskId=${lit(taskId)})`, { role: 'WorkspaceArtifactsDeploy', noCache: true })
  return entity(data)?.Status || null
}

async function listRuntimeArtifacts({ noCache = false } = {}) {
  return results(await get('/IntegrationRuntimeArtifacts', { role: 'MonitoringDataRead', noCache })).map(mapRuntime)
}

/** @returns runtime artifact, or null if the iFlow is not deployed */
async function getRuntimeArtifact(id, { noCache = false } = {}) {
  try {
    return mapRuntime(entity(await get(runtimePath(id), { role: 'MonitoringDataRead', noCache })))
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

/**
 * Deployment/start error of a runtime artifact. CPI returns a JSON document whose
 * human-readable parts sit in (nested) `parameter` arrays; we flatten those.
 * @returns {{ message, details }} or null if there is no error
 */
async function getRuntimeError(id) {
  let text
  try {
    const res = await request({ path: `${runtimePath(id)}/ErrorInformation/$value`, binary: true, role: 'MonitoringDataRead' })
    text = Buffer.from(res.data).toString('utf8')
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
  if (!text.trim()) return null
  try {
    const parts = []
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node && typeof node === 'object')
        for (const [k, v] of Object.entries(node)) {
          if (k === 'parameter' && Array.isArray(v)) parts.push(...v.filter((p) => typeof p === 'string'))
          else walk(v)
        }
    }
    walk(JSON.parse(text))
    return { message: [...new Set(parts)].join('\n') || text, details: text }
  } catch {
    return { message: text, details: text }
  }
}

async function undeployIflow(id) {
  await request({ method: 'DELETE', path: runtimePath(id), role: 'WorkspaceArtifactsDeploy' })
}

// --- Monitoring --------------------------------------------------------------

/**
 * Message processing logs, newest first.
 * @param {{ status?: string, top?: number, sinceHours?: number }} options
 */
async function listMessageLogs({ status, top = 50, sinceHours } = {}) {
  const filters = []
  if (status) {
    status = String(status).toUpperCase()
    if (!MESSAGE_STATUSES.includes(status))
      throw cpiError(400, 'INVALID_STATUS', `Unknown message status '${status}'.`, `Use one of ${MESSAGE_STATUSES.join(', ')}.`)
    filters.push(`Status eq '${status}'`)
  }
  if (sinceHours) {
    // Filter on LogStart: messages still PROCESSING have no LogEnd yet
    const since = new Date(Date.now() - Number(sinceHours) * 3600_000).toISOString().slice(0, 19)
    filters.push(`LogStart gt datetime'${since}'`)
  }
  top = Math.min(Math.max(Number(top) || 50, 1), 500)
  let path = `/MessageProcessingLogs?$orderby=LogEnd%20desc&$top=${top}`
  if (filters.length) path += `&$filter=${encodeURIComponent(filters.join(' and '))}`
  return results(await get(path, { role: 'MonitoringDataRead' })).map(mapMessageLog)
}

// --- Health ------------------------------------------------------------------

let tenantHost

async function getTenantHost() {
  if (tenantHost) return tenantHost
  const dest = await getDestination({ destinationName: DESTINATION })
  if (!dest?.url) throw cpiError(502, 'DESTINATION_ERROR', `Destination ${DESTINATION} not found.`, DESTINATION_HINT)
  return (tenantHost = new URL(dest.url).host)
}

/** Lightweight connectivity check; never throws. */
async function health() {
  const started = Date.now()
  let host = null
  try {
    host = await getTenantHost()
    // No query options: CPI rejects some of them on IntegrationPackages (e.g. "$select is not supported")
    await request({ path: '/IntegrationPackages', role: 'WorkspacePackagesRead' })
    return { connected: true, tenantHost: host, latencyMs: Date.now() - started, error: null }
  } catch (e) {
    const { code, message, hint } = normalizeError(e)
    return { connected: false, tenantHost: host, latencyMs: null, error: { code, message, hint } }
  }
}

module.exports = {
  health,
  // packages
  listPackages,
  getPackage,
  createPackage,
  updatePackage,
  deletePackage,
  downloadPackageZip,
  // iflows
  listIflows,
  getIflow,
  downloadIflowZip,
  createIflow,
  updateIflowContent,
  saveIflowAsVersion,
  deleteIflow,
  // configurations
  getConfigurations,
  updateConfiguration,
  // resources
  listResources,
  getResource,
  upsertResource,
  // runtime
  deployIflow,
  getDeployStatus,
  listRuntimeArtifacts,
  getRuntimeArtifact,
  getRuntimeError,
  undeployIflow,
  // monitoring
  listMessageLogs,
  // misc
  invalidateCache,
  MESSAGE_STATUSES
}
