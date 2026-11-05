/**
 * Import: any CPI iFlow (zip export or a bare .iflw) -> draft iFlow spec v1.
 *
 * Unlike to-spec.js, which must be exact because an update rebuilds the iFlow, import
 * approximates and does not refuse: what the spec cannot build becomes a placeholder Content
 * Modifier whose description (and REPLACE_WITH property) says what to put there in the CPI web
 * editor. A branching flow keeps only its main path (at each router the route with a condition);
 * the other routes are described in the router's placeholder. Consecutive placeholders are merged
 * if a process would exceed its limit (50 steps each, 10 in the exception subprocess), names are made unique, XPath values of Content Modifiers move
 * into a generated Groovy script, and {{Param}} references outside receiver URLs become the
 * parameter's default value.
 * Groovy scripts, XSLT files and the generated scripts are returned as attachments, so the
 * spec references them by file name and the model never sees their content.
 */
const JSZip = require('jszip')
const { parse } = require('./parser')
const cpiValues = require('./cpi-values')
const senderSettings = require('./sender-settings')
const placeholderNotes = require('./placeholders')
const { validate } = require('./validator')
const { IMPORT_NO_PACKAGE } = require('../lib/package-id')

const MAX_STEPS = 50
// data types of the reference exports; Java class names are case-sensitive
const REFERENCE_VALUES = require('./templates/reference-values.json')
const KNOWN_DATATYPES = [...new Set(['Content Modifier', 'Write Variables'].flatMap((c) => Object.keys(REFERENCE_VALUES[c]?.datatype || {})))]
const MAX_EXCEPTION_STEPS = 10
const IFLOW_DIR = 'src/main/resources/scenarioflows/integrationflow/'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const HTTP_URL = /^https?:\/\/\S+$/
const WHOLE_PARAM = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/
const PARAM_REF = /\{\{\s*([^}]*?)\s*\}\}/g
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const ROW_NAME = /^[A-Za-z0-9_.-]+$/
const XSL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*\.xslt?$/

const fail = (code, message, hint) => Object.assign(new Error(message), { code, status: 400, hint })
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const words = (camel) => String(camel || 'step').replace(/([a-z])([A-Z])/g, '$1 $2')

/** Letters, digits, underscore; starts with a letter */
function identifier(s, fallback, max = 50) {
  const id = String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return (/^[A-Za-z]/.test(id) ? id : `${fallback}${id ? `_${id}` : ''}`).slice(0, max)
}

/** Returns a function that makes values unique: "Name", "Name 2", … (or "id", "id_2", …) */
function uniquer(separator) {
  const used = new Set()
  return (value, max = 100) => {
    let v = value
    for (let n = 2; used.has(v); n++) v = `${value.slice(0, max - String(n).length - separator.length)}${separator}${n}`
    used.add(v)
    return v
  }
}

/** Groovy single-quoted string literal */

/** A bare .iflw becomes a minimal zip the parser understands */
async function zipOf(buffer, fileName) {
  if (!/\.iflw$/i.test(fileName || '')) return buffer
  const zip = new JSZip()
  zip.file(`${IFLOW_DIR}${identifier(fileName.replace(/\.iflw$/i, ''), 'Imported')}.iflw`, buffer)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * @param {Buffer} buffer - zip export, or the content of a .iflw file
 * @param {{ fileName: string, packageId?: string }} options
 * @returns {Promise<{ spec: object, attachments: Object<string, string>, notes: string[], placeholders: number, valid: boolean, errors: string[] }>}
 */
async function importIflow(buffer, { fileName, packageId }) {
  const parsed = await parse(await zipOf(buffer, fileName))
  const notes = []
  const attachments = {}
  const params = Object.fromEntries(Object.entries(parsed.parameters || {}).filter(([k]) => PARAM_NAME.test(k)))
  const defaults = parsed.parameters || {} // every parameter's default, also names the spec cannot use
  const uniqueName = uniquer(' ')
  const uniqueSystem = uniquer('_')
  const uniqueFile = uniquer('_')

  /** {{Param}} in notes and descriptions -> its default, so the user reads the real value */
  const withDefaults = (text) => String(text ?? '').replace(PARAM_REF, (m, p) => (defaults[p] ? defaults[p] : m))
  /**
   * The address of a parsed ProcessDirect receiver (a step's or the end's), or null when the spec cannot hold it: a
   * whole {{Parameter}} stays a parameter; another parameter becomes its default (noted) when that is a path
   */
  const processDirectAddress = (r) => {
    const pd = senderSettings.processDirectReceiverOf(r.adapter)
    if (pd.differences?.some((d) => !d.startsWith('the address'))) return null
    const raw = String(r.address ?? '')
    const whole = raw.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
    if (whole && Object.hasOwn(params, whole)) return raw
    const value = withDefaults(raw)
    if (!/^(\/[A-Za-z0-9_.~-]+)+$/.test(value)) return null
    if (value !== raw) notes.push(`${r.system || 'ProcessDirect receiver'}: the address ${raw} became its value ${value}`)
    return value
  }
  /**
   * Authentication, proxy and timeout of a parsed HTTP receiver call, as the spec holds them. A
   * credential name or location ID given as a whole {{Parameter}} stays a parameter; one the spec
   * cannot hold (part of a text, or a name the spec does not allow) becomes its default (noted).
   * Settings the spec cannot hold (unsupportedSettings) are left at their defaults and noted by the caller.
   */
  const receiverFields = (s, system) => {
    const literal = (v, what) => {
      if (!/\{\{/.test(v || '')) return v
      if (Object.hasOwn(params, String(v).match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1] ?? '')) return v
      const value = withDefaults(v)
      if (/\{\{/.test(value)) return undefined // no default: left out, the validator asks for it
      notes.push(`${system}: the ${what} ${v} became its value ${value} (it cannot be kept as a parameter)`)
      return value
    }
    const auth = s.authType && s.authType !== 'None' && !s.unsupportedSettings?.some((u) => u.startsWith('authentication')) ? s.authType : 'None'
    const credentialName = auth !== 'None' ? literal(s.credentialAlias, 'credential name') : undefined
    const locationId = s.proxyType === 'On-Premise' ? literal(s.locationId, 'location ID') : undefined
    return {
      authType: auth,
      ...(credentialName && { credentialName }),
      ...(s.proxyType && { proxyType: s.proxyType }),
      ...(locationId && { locationId }),
      ...(s.timeout && { timeout: s.timeout })
    }
  }
  /**
   * A URL the spec accepts, or null: a literal http(s) URL stays literal, a whole {{Param}} stays, and a
   * URL combined from parameters ({{HTTP_Address}}?{{HTTP_Query}}) becomes one new parameter
   * <System>_URL whose default is the combined value, so the receiver URL stays externalized.
   */
  const httpUrl = (url, system) => {
    if (!url) return null
    // a parameter address with a literal Query field: keep {{P}}, the query joins the default (see splitParameters)
    const withQuery = url.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}\?(.+)$/)
    if (withQuery && !withQuery[2].includes('{{')) {
      params[withQuery[1]] = `${defaults[withQuery[1]] ?? ''}?${withQuery[2]}`
      return `{{${withQuery[1]}}}`
    }
    const whole = url.match(WHOLE_PARAM)
    if (whole) {
      params[whole[1]] ??= ''
      return url
    }
    const resolved = String(url).replace(PARAM_REF, (m, p) => (Object.hasOwn(defaults, p) ? defaults[p] : m))
    if (!HTTP_URL.test(resolved) || /\{\{/.test(resolved)) return null
    if (!/\{\{/.test(url)) return resolved
    let name = identifier(`${system}_URL`, 'Receiver_URL', 60)
    for (let n = 2; Object.hasOwn(params, name); n++) name = identifier(`${system}_URL_${n}`, 'Receiver_URL', 60)
    params[name] = resolved
    notes.push(`${system}: the URL ${url} became the parameter {{${name}}} with the combined value as its default`)
    return `{{${name}}}`
  }

  /**
   * {{Param}} in a value -> the parameter's default (v1 allows parameters only as receiver URLs);
   * `was` collects "Name = default (was {{Name}})" for the step description
   */
  const inlineParams = (value, was) =>
    String(value ?? '').replace(PARAM_REF, (m, p) => {
      const v = defaults[p] ?? ''
      was.push(`${p} = ${v === '' ? '(empty: no default)' : v} (was {{${p}}})`)
      return v
    })

  // the REPLACE_WITH value is configuration, so {{Param}} in the text is written as {Param}
  const placeholder = (name, what) => ({
    type: 'contentModifier',
    name,
    description: truncate(`REPLACE WITH ${what}`, 500),
    properties: [{ name: 'REPLACE_WITH', type: 'constant', value: truncate(what.replace(PARAM_REF, '{$1}'), 250) }],
    placeholder: what
  })

  /** "Route 1 (condition) continues; Route 2 (default) -> A -> B -> End 10" */
  /** A NonXML condition with spaces around its operators (the validator requires them): ${property.x}='A' -> ${property.x} = 'A' */
  const spacedCondition = (c, type) => {
    if (type !== 'NonXML') return c
    const parts = String(c).split(/(\$\{[^}]*\}|'[^']*')/) // operators only outside ${...} and '...'
    return parts
      .map((p, i) => (i % 2 ? p : p.replace(/\s*(!=|<=|>=|=~|=|<|>)\s*/g, ' $1 ')))
      .join('')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  const describeRoutes = (routes) =>
    routes
      .map((r) => {
        const head = `${r.route}${r.isDefault ? ' (default)' : r.condition ? ` (${truncate(r.condition.replace(/\s+/g, ' '), 80)})` : ''}`
        if (r.main) return `${head} continues`
        return [head, ...r.steps, ...(r.rejoin ? [`back to ${r.rejoin}`] : r.end ? [r.end] : [])].join(' -> ')
      })
      .join('; ')

  // XSLT files travel as attachments; v1 has no XSLT step, so they are listed in resources
  let resources = []
  const xslNames = {} // file name in the iFlow -> name in the spec
  for (const m of parsed.mappings || []) {
    const name = XSL_NAME.test(m.fileName) ? m.fileName : `${identifier(m.fileName.replace(/\.xslt?$/i, ''), 'mapping')}.xsl`
    attachments[name] = m.content
    xslNames[m.fileName] = name
    resources.push(name)
  }
  const usedXsl = new Set() // XSLT files a step uses: not listed in resources

  /** A data type in the case the references have (java.lang.string -> java.lang.String), with a note */
  const datatypeOf = (datatype, where) => {
    const known = KNOWN_DATATYPES.find((d) => d.toLowerCase() === String(datatype).toLowerCase())
    if (!known || known === datatype) return datatype
    notes.push(`${where}: the data type ${datatype} became ${known} (Java class names are case-sensitive)`)
    return known
  }

  // Local processes a Process Call may run: by processId, else the only one there is
  const locals = parsed.localProcessSteps || []
  const localProcessOf = (s) => locals.find((l) => l.id === s.processId) || (locals.length === 1 ? locals[0] : null)

  /**
   * Spec steps for one parsed step. where: 'main' (main line), 'route', 'exception' or 'local' (a local
   * process): splitters and gathers only on the main line, process calls not in local processes
   */
  function convert(s, { where = 'main' } = {}) {
    const name = s.name ? truncate(s.name, 100) : undefined
    const label = s.name ? `'${s.name}'` : ''
    switch (s.type) {
      case 'contentModifier': {
        const dropped = []
        const was = []
        const rows = (list = [], table) =>
          list.flatMap((r) => {
            if (r.action && r.action !== 'Create') return dropped.push(`${table} ${r.name} (action ${r.action})`), []
            if (!ROW_NAME.test(r.name || '')) return dropped.push(`${table} '${r.name}' (name not supported)`), []
            const type = cpiValues.cmTypeFromCpi(r.type)
            if (!type) return dropped.push(`${table} ${r.name} (source type ${r.type})`), []
            // a constant may be a whole {{Param}} (an externalized value); elsewhere a parameter becomes its default
            const whole = type === 'constant' && String(r.value ?? '').match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
            const value = whole && Object.hasOwn(params, whole) ? r.value : inlineParams(r.value, was)
            if (['header', 'property', 'globalVariable', 'localVariable', 'xpath'].includes(type) && !value.trim()) return dropped.push(`${table} ${r.name} (${r.type} is empty)`), []
            return [{ name: r.name, type, value, ...(r.datatype && { datatype: datatypeOf(r.datatype, `${s.name}, ${table} ${r.name}`) }), ...(r.default && { default: r.default }) }]
          })
        const cm = { type: 'contentModifier', ...(name && { name }) }
        const headers = rows(s.headers, 'header')
        const properties = rows(s.properties, 'property')
        if (headers.length) cm.headers = headers
        if (properties.length) cm.properties = properties
        if (s.body) cm.body = inlineParams(s.body, was)
        // a real step: the rows the spec cannot hold are noted, the step is not a placeholder
        const notes_ = [
          ...(dropped.length ? [`Add in the CPI web editor: ${dropped.join('; ')} (not supported by the spec)`] : []),
          ...(was.length ? [`Parameter defaults used: ${[...new Set(was)].join('; ')}`] : [])
        ]
        if (notes_.length) cm.description = truncate(notes_.join('. '), 500)
        // a placeholder (an AI's PH_ step or an earlier Import's): recognised by its REPLACE_WITH property, as the
        // description is not written into the iFlow; it stays a placeholder, so the app does not deploy it
        const replaceWith = (cm.properties || []).find((p) => p.name === 'REPLACE_WITH' && p.type === 'constant')
        if (replaceWith && placeholderNotes.usable(placeholderNotes.noteOf(cm))) return [{ ...cm, description: `REPLACE WITH ${placeholderNotes.noteOf(cm)}`, placeholder: placeholderNotes.noteOf(cm) }]
        return [cm]
      }
      case 'writeVariables': {
        if (where === 'exception') return [placeholder(name, `Write Variables ${label}: ${s.variables.map((v) => `${v.name} = ${v.value} (${v.type})`).join(', ')} (not supported in the exception subprocess)`)]
        const variables = s.variables.filter((v) => cpiValues.WV_TYPES.includes(v.type) && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(v.name || '') && v.value)
        if (!variables.length) return [placeholder(name, `Write Variables ${label}: ${s.variables.map((v) => `${v.name} (${v.type})`).join(', ')}`)]
        const step = {
          type: 'writeVariables',
          ...(name && { name }),
          variables: variables.map((v) => ({ name: v.name, type: v.type, value: v.value, ...(v.datatype && { datatype: datatypeOf(v.datatype, `${s.name}, variable ${v.name}`) }), ...(v.global && { global: true }) }))
        }
        const left = s.variables.filter((v) => !variables.includes(v))
        if (left.length) step.description = truncate(`Add in the CPI web editor: ${left.map((v) => `variable ${v.name} (type ${v.type})`).join('; ')} (not supported by the spec)`, 500)
        return [step]
      }
      case 'groovyScript': {
        const file = (parsed.scripts || []).find((f) => f.fileName === `${s.fileName}.groovy`)
        if (!file) return [placeholder(name, `Groovy script ${label} (${s.script || 'file'} is missing in the export)`)]
        const fileName = uniqueFile(identifier(s.fileName, 'script'), 50)
        attachments[`${fileName}.groovy`] = file.content
        const step = { type: 'groovyScript', ...(name && { name }), fileName }
        if (s.function && s.function !== 'processData')
          step.description = `REPLACE WITH the entry function ${s.function}(): the app calls processData(). Rename the function in ${fileName}.groovy or set it in the CPI web editor.`
        return [step]
      }
      case 'jsonToXml':
      case 'xmlToJson':
        return [{ type: s.type, ...(name && { name }) }]
      case 'requestReplyHttp': {
        if (where === 'exception') return [placeholder(name, `HTTP request-reply ${label} to ${s.url || '?'} (not supported in the exception subprocess)`)]
        const system = uniqueSystem(identifier(s.system, 'Receiver'), 50)
        const url = httpUrl(s.url, system)
        if (!url) return [placeholder(name, `HTTP request-reply ${label} to ${s.url || '?'} (the URL could not be converted)`)]
        const step = { type: 'requestReplyHttp', ...(name && { name }), system, url, method: METHODS.includes(s.method) ? s.method : 'GET', ...receiverFields(s, system) }
        if (s.unsupportedSettings?.length) step.description = `Set ${s.unsupportedSettings.map(withDefaults).join(', ')} on ${system} in the CPI web editor.`
        return [step]
      }
      case 'messageMapping': {
        const raw = s.settings || {}
        const what = `Message Mapping ${label} (${s.mapping ? `artifact ${s.mapping}` : s.file})`
        if (raw.mappingReference !== 'static' || raw.mappingSourceValue || /\{\{/.test(s.mapping || s.file || '')) return [placeholder(name, `${what}: a mapping chosen at runtime or by a parameter`)]
        if (s.mapping) return [{ type: 'messageMapping', ...(name && { name }), mapping: s.mapping }]
        // a mapping inside the iFlow: the file and its schemas travel as attachments, under their own names (the file refers to them)
        const carried = [s.file, ...(s.schemas || [])].map((f) => (parsed.resourceFiles || []).find((x) => x.fileName === f))
        if (!carried[0]) return [placeholder(name, `${what}: the file is missing in the export`)]
        for (const f of carried) if (f) attachments[f.fileName] = f.content
        return [{ type: 'messageMapping', ...(name && { name }), file: s.file, ...(s.schemas?.length && { schemas: s.schemas }) }]
      }
      case 'xsltMapping': {
        const raw = s.settings || {}
        const what = `XSLT Mapping ${label} (${s.file})`
        const file = xslNames[s.file]
        if (!file) return [placeholder(name, `${what}: the file is missing in the export`)]
        if (raw.mappingSource !== 'mappingSrcIflow' || raw.mappingoutputformat !== 'Bytes') return [placeholder(name, `${what}: source ${raw.mappingSource}, output format ${raw.mappingoutputformat}`)]
        usedXsl.add(file)
        return [{ type: 'xsltMapping', ...(name && { name }), file }]
      }
      case 'requestReplyProcessDirect': {
        const what = `ProcessDirect request-reply ${label} to ${s.address || '?'}`
        if (where === 'exception') return [placeholder(name, `${what} (not supported in the exception subprocess)`)]
        const address = processDirectAddress(s)
        if (!address) return [placeholder(name, what)]
        return [{ type: 'requestReplyProcessDirect', ...(name && { name }), system: uniqueSystem(identifier(s.system, 'Receiver'), 50), address }]
      }
      case 'requestReplyOData': {
        // kept only as the builder writes it (sender-settings); a whole {{Parameter}} needs its value in the export
        const what = `OData V2 request-reply ${label} (${s.operation || '?'} ${s.resourcePath || '?'}) to ${s.url || '?'}`
        if (where === 'exception') return [placeholder(name, `${what} (not supported in the exception subprocess)`)]
        const odata = senderSettings.odataReceiverOf(s.adapter)
        if (odata.differences) return [placeholder(name, `${what} (${odata.differences.join('; ')})`)]
        const undefinedParam = Object.values(odata.call).find((v) => /^\{\{/.test(v) && !Object.hasOwn(params, v.slice(2, -2)))
        if (undefinedParam) return [placeholder(name, `${what} (the parameter ${undefinedParam} has no value in the export)`)]
        return [{ type: 'requestReplyOData', ...(name && { name }), system: uniqueSystem(identifier(s.system, 'Receiver'), 50), ...odata.call }]
      }
      case 'sendSftp': {
        // kept only as the builder writes it (sender-settings); a whole {{Parameter}} needs its value in the export
        const what = `SFTP Send ${label} to ${s.host || '?'}${s.directory ? ` ${s.directory}` : ''}`
        const sftp = senderSettings.sftpReceiverOf(s.adapter)
        if (sftp.differences) return [placeholder(name, `${what} (${sftp.differences.join('; ')})`)]
        const undefinedParam = Object.values(sftp.call).find((v) => /^\{\{/.test(v) && !Object.hasOwn(params, v.slice(2, -2)))
        if (undefinedParam) return [placeholder(name, `${what} (the parameter ${undefinedParam} has no value in the export)`)]
        return [{ type: 'sendSftp', ...(name && { name }), system: uniqueSystem(identifier(s.system, 'Receiver'), 50), ...sftp.call }]
      }
      case 'requestReplySoap': {
        const raw = s.settings || {}
        const what = `SOAP request-reply ${label} to ${s.url || '?'}`
        if (where === 'exception') return [placeholder(name, `${what} (not supported in the exception subprocess)`)]
        const used = (key) => withDefaults(raw[key] ?? '')
        // what the spec cannot hold (values resolved: a setting may be a parameter): the step stays a placeholder
        const wsdl = ['soapWsdlURL', 'soapServiceName', 'soapWsdlPortName', 'operationName'].filter((k) => used(k) && !/\{\{/.test(used(k)))
        if (wsdl.length) return [placeholder(name, `${what} (with ${wsdl.map((k) => `${k} ${used(k)}`).join(', ')})`)]
        if (used('authentication') !== 'Basic' || used('proxyType') !== 'sapcc') return [placeholder(name, `${what} (authentication ${used('authentication')}, proxy ${used('proxyType')}; supported: Basic, On-Premise)`)]
        if (used('WSSecurity_outbound') !== 'None') return [placeholder(name, `${what} (WS-Security ${used('WSSecurity_outbound')})`)]
        const system = uniqueSystem(identifier(s.system, 'Receiver'), 50)
        const url = httpUrl(s.url, system)
        if (!url) return [placeholder(name, `${what} (the URL could not be converted)`)]
        // on a SOAP receiver only the url can stay a parameter
        const literal = (key, what_) => {
          const value = used(key)
          if (/\{\{/.test(raw[key] ?? '') && value && !/\{\{/.test(value)) notes.push(`${system}: the ${what_} ${raw[key]} became its value ${value} (it cannot be kept as a parameter)`)
          return /\{\{/.test(value) ? '' : value
        }
        const credentialName = literal('credentialName', 'credential name')
        if (!/^[A-Za-z0-9_.-]{1,150}$/.test(credentialName)) return [placeholder(name, `${what} (credential name ${raw.credentialName || 'missing'})`)]
        const locationId = literal('location_id', 'location ID')
        const timeout = Number(used('requestTimeout'))
        return [
          {
            type: 'requestReplySoap',
            ...(name && { name }),
            system,
            url,
            authType: 'Basic',
            credentialName,
            proxyType: 'On-Premise',
            ...(/^[A-Za-z0-9_.-]{1,100}$/.test(locationId) && { locationId }),
            ...(Number.isInteger(timeout) && timeout > 0 && timeout !== 60000 && { timeout })
          }
        ]
      }
      case 'sendMail': {
        const raw = s.settings || {}
        const what = `Mail ${label} to ${s.to || '?'} via ${s.server || '?'}`
        const used = (key) => withDefaults(raw[key] ?? '')
        if (used('auth') !== 'loginPlain' || used('ssl') !== 'starttls_mandatory' || used('content_type') !== 'text/plain' || used('attachments') || used('encrypt.type') !== 'none')
          return [placeholder(name, `${what} (authentication ${used('auth')}, protection ${used('ssl')}, body type ${used('content_type')}${used('attachments') ? ', attachments' : ''}; supported: Plain User/Password, STARTTLS mandatory, text/plain)`)]
        const system = uniqueSystem(identifier(s.system, 'Receiver'), 50)
        // server, credential name and recipients may stay a whole parameter; other parameters become their defaults
        const field = (key, pattern) => {
          const whole = String(raw[key] ?? '').match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)?.[1]
          if (whole && Object.hasOwn(params, whole)) return raw[key]
          const value = used(key)
          return pattern.test(value) ? value : null
        }
        const ADDRESSES = /^[^\s,@]+@[^\s,@]+(\s*,\s*[^\s,@]+@[^\s,@]+)*$/
        const server = field('server', /^[A-Za-z0-9.-]+:[0-9]{1,5}$/)
        const credentialName = field('user', /^[A-Za-z0-9_.-]{1,150}$/)
        const to = field('to', ADDRESSES)
        const from = used('from')
        const subject = used('subject')
        if (!server || !credentialName || !to || !/^[^\s,@]+@[^\s,@]+$/.test(from) || !subject) return [placeholder(name, `${what} (a server, credential name, sender, recipient or subject the spec cannot hold)`)]
        const body = used('body')
        return [
          {
            type: 'sendMail',
            ...(name && { name }),
            system,
            server,
            credentialName,
            from,
            to,
            ...(ADDRESSES.test(used('cc')) && { cc: used('cc') }),
            ...(ADDRESSES.test(used('bcc')) && { bcc: used('bcc') }),
            subject,
            ...(raw.body != null && raw.body !== '${in.body}' && { body })
          }
        ]
      }
      case 'requestReply': {
        const a = s.adapter || {}
        return [placeholder(name, `request-reply ${label} via the ${a.type || 'unknown'} adapter${a.system ? ` to ${a.system}` : ''}${a.address ? ` (${a.address})` : ''}`)]
      }
      case 'router':
        return [placeholder(name, s.routes ? `Router ${label}: ${describeRoutes(s.routes)}` : `Router ${label} (its branches were imported one after another)`)]
      case 'parallelMulticast':
        return [placeholder(name, s.routes ? `Parallel Multicast ${label}: ${describeRoutes(s.routes)}` : `Parallel Multicast ${label} (its branches were imported one after another)`)]
      case 'script':
        return [placeholder(name, `${s.language || 'script'} step ${label} (${s.script || 'script'})`)]
      case 'processCall': {
        const lip = localProcessOf(s)
        const what = `${s.loop ? 'Looping Process Call' : 'Process Call'} ${label}${lip ? ` to the local process '${lip.name}'` : ''}`
        if (where === 'local') return [placeholder(name, `${what} (not supported inside a local process)`)]
        if (!lip || !lip.steps.length) return [placeholder(name, `${what}${lip ? ' (the local process has no steps)' : ''}`)]
        if (s.subActivityType && !['NonLoopingProcess', 'LoopingProcess'].includes(s.subActivityType)) return [placeholder(name, `${words(s.subActivityType)} ${label} to the local process '${lip.name}'`)]
        if (s.loop && (s.loop.expressionType !== 'Non XML' || !s.loop.condition || !s.loop.max))
          return [placeholder(name, `${what}: ${s.loop.expressionType || 'its'} condition ${s.loop.condition || '(none)'}, at most ${s.loop.max || '?'} times`)]
        const loop = s.loop && { condition: spacedCondition(withDefaults(s.loop.condition), 'NonXML'), max: s.loop.max }
        return [{ type: 'processCall', ...(name && { name }), process: lip.name, ...(loop && { loop }) }]
      }
      case 'splitter': {
        const what = `${s.splitType ? words(s.splitType) : 'Splitter'} ${label}${s.expression ? ` (${s.exprType ? `${s.exprType} ` : ''}${s.expression})` : ''}`
        if (where !== 'main') return [placeholder(name, `${what}: splitters are supported on the main line only`)]
        // settings given as {{Parameter}} take the parameter's default (a splitter holds no parameters)
        const raw = s.settings || {}
        const used = Object.values(raw).filter((v) => /\{\{/.test(v ?? ''))
        const value = (key, parsedValue) => (raw[key] != null ? withDefaults(raw[key]) : parsedValue)
        const exprType = value('exprType', s.exprType)
        const expression = value('splitExprValue', s.expression)
        const flag = (key, parsedValue) => (raw[key] != null ? value(key) === 'true' : parsedValue)
        const grouping = Number(value('grouping', s.grouping)) || 1
        const parallel = flag('ParallelProcessing', s.parallel)
        if (!s.kind || exprType !== 'XPath' || parallel || /\{\{/.test(expression)) return [placeholder(name, `${what}${parallel ? ', parallel processing' : ''}`)]
        if (used.length) notes.push(`${s.name || 'Splitter'}: the parameters ${[...new Set(used)].join(', ')} became their values (a splitter holds no parameters)`)
        return [
          {
            type: 'splitter',
            ...(name && { name }),
            kind: s.kind,
            expression,
            ...(grouping !== 1 && { grouping }),
            ...(!flag('Streaming', s.streaming) && { streaming: false }),
            stopOnException: flag('StopOnExecution', s.stopOnException)
          }
        ]
      }
      case 'gather': {
        const what = `Gather ${label} (${s.messageType || 'format'}, ${s.aggregationAlgorithm || 'algorithm'})`
        if (where !== 'main') return [placeholder(name, `${what}: gathers are supported on the main line only`)]
        if (s.messageType !== 'SameXMLFormat') return [placeholder(name, what)]
        if (s.aggregationAlgorithm === cpiValues.GATHER_COMBINE) return [{ type: 'gather', ...(name && { name }) }]
        if (s.aggregationAlgorithm !== cpiValues.GATHER_AT_XPATH || !s.source || !s.target) return [placeholder(name, what)]
        return [{ type: 'gather', ...(name && { name }), source: s.source, target: s.target }]
      }
      default:
        return [placeholder(name, `${words(s.activityType || s.type)} ${label}${/mapping/i.test(s.activityType || '') && resources.length ? ` (the XSLT files are included as resources)` : ''}`.replace(/\s+$/, ''))]
    }
  }

  // --- trigger -------------------------------------------------------------------------
  // iFlow ids are unique per tenant: the import is always proposed under a new id
  const original = identifier(parsed.id || (fileName || '').replace(/\.(zip|iflw)$/i, ''), 'iFlow', 100 - '_Imported'.length)
  const id = `${original}_Imported`
  notes.push(`iFlow id: ${id}, a new id (iFlow ids are unique per tenant${parsed.id ? `; the original is ${parsed.id}` : ''}); change it before proposing if you like`)
  const fallbackAddress = `/imported/${id.toLowerCase()}`
  const t = parsed.trigger || {}
  let trigger
  if (t.type === 'timer') {
    // every N minutes stays when N is a value of the reference exports; any other schedule becomes run once
    const every = t.mode === 'every' && !cpiValues.checkValues('Timer', cpiValues.timerValues(t), 'trigger').errors.length
    trigger = every ? { type: 'timer', mode: 'every', minutes: t.minutes } : { type: 'timer', mode: 'once' }
    if (t.mode !== 'once' && !every) notes.push('Trigger: the timer schedule became "run once after deployment"; set the schedule in the CPI web editor')
  } else if (t.type === 'httpsSender') {
    const address = '/' + String(t.address || '').split('/').map((seg) => seg.replace(/[^A-Za-z0-9_.~-]/g, '-')).filter(Boolean).join('/')
    trigger = { type: 'httpsSender', address: address === '/' ? fallbackAddress : address }
    if (trigger.address !== t.address) notes.push(`Trigger: HTTPS address ${t.address || '(none)'} became ${trigger.address}`)
  } else {
    // a sender the spec holds exactly (its settings as the builder writes them, no parameters): kept; else HTTPS
    const sender = t.type === 'sender' ? senderSettings.triggerOf((parsed.adapters || []).find((a) => a.direction === 'Sender')) : null
    if (sender?.trigger) trigger = sender.trigger
    else {
      trigger = { type: 'httpsSender', address: fallbackAddress }
      notes.push(
        `Trigger: ${t.type === 'sender' ? `the ${t.adapter} sender` : 'the start event'}${sender ? ` (${sender.differences.join('; ')})` : ''} was replaced by an HTTPS sender at ${fallbackAddress}; set up the original sender in the CPI web editor`
      )
    }
  }

  // --- steps -----------------------------------------------------------------------------
  // a branching flow the spec can hold: routers with routes that end or join again (parser: routed)
  const routed = parsed.routed && !parsed.routed.unsupported ? parsed.routed : null
  const branching = routed ? null : parsed.mainPath
  // an Escalation End's category: kept when the spec allows it, else the default with a note
  const ESCALATION_CATEGORIES = require('./spec-schema.json').definitions.endEvent.properties.category.enum
  const categoryOf = (category, where) => {
    if (!category || ESCALATION_CATEGORIES.includes(category)) return category ? { category } : {}
    notes.push(`${where}: the escalation category ${category} became Others; set ${category} in the CPI web editor`)
    return { category: 'Others' }
  }
  const routeEnd = (end, where) => {
    if (end.kind === 'message' || !['escalation', 'error'].includes(end.kind)) return { event: 'message', ...(end.name && { name: truncate(end.name, 100) }) }
    return { event: end.kind, ...(end.name && { name: truncate(end.name, 100) }), ...(end.kind === 'escalation' && categoryOf(end.category, where)) }
  }
  // in a local process (inLocal): its route steps are converted as local steps, and a route ends with a plain End
  const routerOf = (r, { inLocal = false } = {}) => ({
    type: 'router',
    ...(r.name && { name: truncate(r.name, 100) }),
    expressionType: r.expressionType || 'NonXML',
    routes: r.routes.map((route) => {
      if (route.end && !['message', 'escalation', 'error'].includes(route.end.kind)) notes.push(`${r.name}, route ${route.name}: a ${route.end.kind} end became a Message End; set it in the CPI web editor`)
      const steps_ = route.steps.flatMap((x) => convert(x, { where: inLocal ? 'local' : 'route' }))
      if (inLocal && route.end && route.end.kind !== 'message')
        notes.push(`${r.name}, route ${route.name}: a ${route.end.kind} end in a local process became a plain End; set it in the CPI web editor`)
      return {
        name: truncate(route.name, 100),
        ...(route.default ? { default: true } : { condition: spacedCondition(withDefaults(route.condition), r.expressionType) }),
        ...(steps_.length && { steps: steps_ }),
        ...(route.end && { end: inLocal ? { event: 'message', ...(route.end.name && { name: truncate(route.end.name, 100) }) } : routeEnd(route.end, `${r.name}, route ${route.name}`) })
      }
    })
  })
  // a gather needs the splitter before it, and there is no second splitter until then: else a placeholder.
  // In a branch a router before a gather, a router whose routes join again and a split without a gather become
  // placeholders too (the validator's rules)
  const gatherText = (g) => (g.source ? ` (combine at ${g.source} into ${g.target})` : ' (combine)')
  const splitterText = (s) => `${s.kind === 'general' ? 'General' : 'Iterating'} Splitter '${s.name || ''}' (${s.expression})`
  const routeText = (r) => `${r.name}${r.condition ? ` (${r.condition})` : ''}: ${(r.steps || []).map((x) => x.name || x.type).join(', ') || 'no steps'}${r.end ? ', then it ends' : ''}`
  const closeSplits = (list, inBranch = false) => {
  let split = null
  let routed_ = false // a router since the splitter: CPI refuses one before the gather
  const out = list.map((s, i) => {
    if (s.type === 'router' && inBranch && s.routes.filter((r) => !r.end).length > 1) return placeholder(s.name, `Router '${s.name || ''}' whose routes join again in a multicast branch, which CPI does not accept (${s.routes.map(routeText).join('; ')})`)
    if (s.type === 'router' && (split || inBranch)) routed_ = true
    if (s.type === 'multicast') {
      const next = list[i + 1]
      if (!split && next?.type === 'gather' && !next.source) return s
      const branches = s.branches.map((b) => `${b.name || 'a branch'}: ${b.steps.map((x) => x.name || x.type).join(', ')}`).join('; ')
      return placeholder(s.name, `${s.mode === 'sequential' ? 'Sequential' : 'Parallel'} Multicast '${s.name || ''}' with its Join ${s.join || ''} (${branches})${split ? ' inside a split' : ', not followed by a Combine gather'}`)
    }
    if (s.type === 'gather' && list[i - 1]?.type === 'multicast' && !split && !s.source) return s
    if (s.type === 'splitter') {
      if (split) {
        notes.push(`${s.name || 'A splitter'}: a split inside the split of ${split.name || 'the splitter before it'} is not supported; it became a placeholder`)
        return placeholder(s.name, `${s.kind === 'general' ? 'General' : 'Iterating'} Splitter '${s.name || ''}' (${s.expression}) inside the split of ${split.name || 'the splitter before it'}`)
      }
      split = s
      routed_ = inBranch && routed_
    }
    if (s.type === 'gather') {
      if (!split) return placeholder(s.name, `Gather '${s.name || ''}'${gatherText(s)} without a splitter before it`)
      split = null
      if (routed_) return placeholder(s.name, `Gather '${s.name || ''}'${gatherText(s)} after a router in the split; move the routing into a local process`)
    }
    return s
  })
  // a split the branch does not close (its gather is a placeholder, or missing)
  if (inBranch) {
    const closes = (i) => out.slice(i + 1).some((x) => x.type === 'gather')
    return out.map((s, i) => (s.type === 'splitter' && !closes(i) ? placeholder(s.name, `${splitterText(s)} without a gather in its branch`) : s))
  }
  return out
  }
  const multicastOf = (m) => ({
    type: 'multicast',
    ...(m.name && { name: truncate(m.name, 100) }),
    mode: m.mode,
    ...(m.join && { join: truncate(m.join, 100) }),
    branches: m.branches.map((b) => ({ ...(b.name && { name: truncate(b.name, 100) }), steps: closeSplits(b.steps.flatMap((s) => (s.type === 'router' ? [routerOf(s)] : convert(s))), true) }))
  })
  let steps = routed
    ? routed.steps.flatMap((s) => (s.type === 'router' ? [routerOf(s)] : s.type === 'multicast' ? [multicastOf(s)] : convert(s)))
    : (branching ? branching.steps : parsed.steps || []).flatMap((s) => convert(s))
  steps = closeSplits(steps)
  if (routed) notes.push(`The flow branches: ${routed.steps.filter((s) => s.type === 'router').length} router(s) were imported with their routes`)
  else if (branching) {
    if (parsed.routed?.unsupported) notes.push(`The routers could not be imported as routers: ${parsed.routed.unsupported}`)
    const routers = branching.steps.filter((s) => s.routes).length
    const side = branching.steps.flatMap((s) => (s.routes || []).filter((r) => !r.main)).reduce((n, r) => n + r.steps.length, 0)
    notes.push(`The flow branches: only the main path was imported (at each router, the route with a condition). ${side} step(s) of other routes are described in the ${routers} router placeholder(s)`)
  } else if (!parsed.linear) notes.push('The flow branches: the steps of all branches were put one after another; check the order')

  // --- end -------------------------------------------------------------------------------
  const e = (routed ? routed.end : branching ? branching.end : parsed.end) || {}
  let end = { type: 'none' }
  if (routed && e.kind && e.kind !== 'message' && e.type === 'none')
    end = { type: 'none', ...(['escalation', 'error'].includes(e.kind) && { event: e.kind }), ...(e.kind === 'escalation' && categoryOf(e.category, 'The main end')) }
  if (e.type === 'httpReceiver') {
    const system = identifier(e.system, 'Receiver')
    const url = httpUrl(e.url, system)
    if (url) {
      const endSystem = uniqueSystem(system, 50)
      end = { type: 'httpReceiver', system: endSystem, url, method: METHODS.includes(e.method) ? e.method : 'POST', ...receiverFields(e, endSystem) }
      if (e.unsupportedSettings?.length) notes.push(`End receiver ${endSystem}: set ${e.unsupportedSettings.map(withDefaults).join(', ')} in the CPI web editor`)
    } else steps.push(placeholder(undefined, `the HTTP receiver ${e.system || ''} at ${e.url || '?'} (the URL could not be converted)`))
  } else if (e.type === 'processDirectReceiver') {
    const address = processDirectAddress(e)
    if (address) end = { type: 'processDirectReceiver', system: uniqueSystem(identifier(e.system, 'Receiver'), 50), address }
    else steps.push(placeholder(undefined, `the ProcessDirect receiver ${e.system || ''} at ${e.address || '?'}`))
  } else if (e.type === 'receiver') steps.push(placeholder(undefined, `the ${e.adapter} receiver${e.system ? ` ${e.system}` : ''}${e.address ? ` (${e.address})` : ''}`))

  // --- exception subprocess ----------------------------------------------------------------
  let exceptionSubprocess
  if (parsed.exceptionSubprocess) {
    const subSteps = parsed.exceptionSubprocess.steps.flatMap((s) => convert(s, { where: 'exception' }))
    const endKind = parsed.exceptionSubprocess.end
    if (subSteps.length)
      exceptionSubprocess = {
        ...(parsed.exceptionSubprocess.name && { name: truncate(parsed.exceptionSubprocess.name, 100) }),
        steps: subSteps,
        // Escalation and Error End are kept (phase 1b)
        ...(['escalation', 'error'].includes(endKind) && {
          end: {
            event: endKind,
            ...(parsed.exceptionSubprocess.endName && { name: truncate(parsed.exceptionSubprocess.endName, 100) }),
            ...(endKind === 'escalation' && categoryOf(parsed.exceptionSubprocess.endCategory, 'Exception subprocess'))
          }
        })
      }
    else notes.push('The exception subprocess has no steps and was left out (the spec needs at least one)')
    if (subSteps.length && endKind === 'terminate') {
      // the spec has no Terminate End: the import ends the subprocess with a Message End
      const last = subSteps.at(-1)
      last.description = truncate([last.description, 'Add in the CPI web editor: Terminate End after this step (the import ends the exception subprocess with a Message End)'].filter(Boolean).join('. '), 500)
      notes.push('Exception subprocess: the original ends with a Terminate End; the import uses a Message End. Add in the CPI web editor: Terminate End')
    }
  }

  // --- local processes: every one, with its steps (what a local process cannot hold becomes a placeholder) ---
  const localProcesses = locals
    .filter((lp) => (parsed.localProcesses || []).includes(lp.name))
    .map((lp) => {
      const routed_ = lp.routed && !lp.unsupported
      if (!lp.linear && !routed_) notes.push(`Local process ${lp.name} branches${lp.unsupported ? ` (${lp.unsupported})` : ''}: its steps were put one after another; check the order`)
      if (lp.end && lp.end !== 'message' && !routed_) notes.push(`Local process ${lp.name}: its ${lp.end} end became a plain End; set it in the CPI web editor`)
      const lpSteps = lp.steps.flatMap((x) => (routed_ && x.type === 'router' ? [routerOf(x, { inLocal: true })] : convert(x, { where: 'local' })))
      return { name: truncate(lp.name, 100), steps: lpSteps.length ? lpSteps : [placeholder(undefined, `the steps of the local process ${lp.name} (it has none)`)] }
    })
  if ((parsed.integrationProcesses?.length || 0) > 1)
    notes.push(`Only the integration process "${parsed.integrationProcesses[0]}" was imported; not imported: ${parsed.integrationProcesses.slice(1).join(', ')}`)
  else if (parsed.warnings?.length) notes.push(...parsed.warnings)

  // --- limits: merge consecutive placeholders, longest runs first ---------------------------
  // per process: limit, with inRoutes steps already taken by the routes of this process
  const mergeRuns = (list, limit, where, inRoutes = 0) => {
    const max = limit - inRoutes
    let out = list
    while (out.length > max) {
      const runs = []
      out.forEach((s, i) => (s.placeholder ? (i > 0 && out[i - 1].placeholder ? runs.at(-1).push(i) : runs.push([i])) : null))
      const run = runs.filter((r) => r.length > 1).sort((a, b) => b.length - a.length)[0]
      if (!run) break
      const parts = run.map((i) => out[i].placeholder)
      const merged = placeholder(out[run[0]].name, parts.join('; then '))
      out = [...out.slice(0, run[0]), merged, ...out.slice(run.at(-1) + 1)]
      notes.push(`${where}: ${run.length} consecutive placeholders were merged into one to stay within ${limit} steps`)
    }
    if (out.length > max)
      throw fail(
        'IMPORT_TOO_LARGE',
        `${where} has ${out.length + inRoutes} steps after merging placeholders${inRoutes ? `, ${inRoutes} of them inside routes` : ''}; its limit is ${limit}.`,
        'Split the iFlow, or remove steps before importing.'
      )
    return out
  }
  // each process has its own limit: routers, the steps inside its routes and its multicasts' branches count; only placeholders on its line are merged
  const nestedSteps = (list) =>
    list.flatMap((s) => (s.type === 'router' ? s.routes.flatMap((x) => x.steps || []) : s.type === 'multicast' ? s.branches.flatMap((b) => [...b.steps, ...nestedSteps(b.steps)]) : []))
  const inRoutes = (list) => nestedSteps(list).length
  steps = mergeRuns(steps, MAX_STEPS, 'Main flow', inRoutes(steps))
  for (const lp of localProcesses) lp.steps = mergeRuns(lp.steps, MAX_STEPS, `Local process ${lp.name}`, inRoutes(lp.steps))
  if (exceptionSubprocess) exceptionSubprocess.steps = mergeRuns(exceptionSubprocess.steps, MAX_EXCEPTION_STEPS, 'Exception subprocess')

  // --- unique names, placeholder markers removed ------------------------------------------------
  const finish = (s) => {
    const { placeholder: what, ...step } = s
    return { ...step, name: uniqueName(s.name || (what ? 'Placeholder' : step.type === 'groovyScript' ? 'Groovy Script' : step.type === 'contentModifier' ? 'Content Modifier' : words(step.type))) }
  }
  const withNested = (list) => [...list, ...nestedSteps(list)]
  const placeholders = [...withNested(steps), ...(exceptionSubprocess?.steps || []), ...localProcesses.flatMap((lp) => withNested(lp.steps))].filter((s) => s.placeholder).length
  const finishLine = (list) =>
    list.map((s) =>
      s.type === 'router'
        ? { ...finish(s), routes: s.routes.map((x) => (x.steps ? { ...x, steps: x.steps.map(finish) } : x)) }
        : s.type === 'multicast'
          ? { ...finish(s), ...(s.join && { join: uniqueName(s.join) }), branches: s.branches.map((b) => ({ ...b, steps: finishLine(b.steps) })) }
          : finish(s)
    )
  steps = finishLine(steps)

  if (exceptionSubprocess) {
    exceptionSubprocess.steps = exceptionSubprocess.steps.map(finish)
    exceptionSubprocess.name = uniqueName(exceptionSubprocess.name || 'Exception Subprocess 1')
  }
  for (const lp of localProcesses) lp.steps = finishLine(lp.steps)

  resources = resources.filter((r) => !usedXsl.has(r))
  const description = truncate(`Imported from ${fileName}.${parsed.description ? ` ${parsed.description}` : ''}`, 1000)
  const spec = {
    id,
    name: truncate(parsed.name || id, 100),
    description,
    packageId: /^[A-Za-z0-9.]+$/.test(packageId || '') ? packageId : IMPORT_NO_PACKAGE,
    trigger,
    steps,
    end,
    ...(exceptionSubprocess && { exceptionSubprocess }),
    ...(localProcesses.length && { localProcesses }),
    ...(Object.keys(params).length && { parameters: params }),
    ...(resources.length && { resources })
  }
  if (spec.packageId === IMPORT_NO_PACKAGE) notes.push('Target package: none yet. Name one when you ask me to propose it; otherwise I will ask you for one.')
  if (placeholders) notes.push(`${placeholders} placeholder step(s) say what to replace them with in the CPI web editor`)
  const { valid, errors } = validate(spec, { attachments: Object.keys(attachments) })
  return { spec, attachments, notes, placeholders, valid, errors }
}

module.exports = { importIflow }
