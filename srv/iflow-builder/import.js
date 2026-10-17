/**
 * Import: any CPI iFlow (zip export or a bare .iflw) -> draft iFlow spec v1.
 *
 * Unlike to-spec.js, which must be exact because an update rebuilds the iFlow, import
 * approximates and does not refuse: what the spec cannot build becomes a placeholder Content
 * Modifier whose description (and REPLACE_WITH property) says what to put there in the CPI web
 * editor. Consecutive placeholders are merged if the flow would exceed 25 steps, names are
 * made unique, and XPath values of Content Modifiers move into a generated Groovy script.
 * Groovy scripts, XSLT files and the generated scripts are returned as attachments, so the
 * spec references them by file name and the model never sees their content.
 */
const JSZip = require('jszip')
const { parse } = require('./parser')
const { validate } = require('./validator')

const MAX_STEPS = 25
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
const groovyString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

/** Groovy that sets the XPath values a Content Modifier had (v1 has constant and expression only) */
function xpathGroovy(stepName, entries) {
  const sets = entries.map((e) => `    message.set${e.table === 'header' ? 'Header' : 'Property'}(${groovyString(e.name)}, xpath.evaluate(${groovyString(e.xpath)}, doc))`)
  return [
    'import com.sap.gateway.ip.core.customdev.util.Message',
    'import javax.xml.parsers.DocumentBuilderFactory',
    'import javax.xml.xpath.XPathFactory',
    '',
    `// Generated on import: the XPath values of Content Modifier ${groovyString(stepName)}.`,
    '// Namespace prefixes are not mapped; adjust the expressions if the XML uses namespaces.',
    'def Message processData(Message message) {',
    "    def body = message.getBody(String) ?: '<empty/>'",
    "    def doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(new ByteArrayInputStream(body.getBytes('UTF-8')))",
    '    def xpath = XPathFactory.newInstance().newXPath()',
    ...sets,
    '    return message',
    '}',
    ''
  ].join('\n')
}

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
  const uniqueName = uniquer(' ')
  const uniqueSystem = uniquer('_')
  const uniqueFile = uniquer('_')

  const resolveParams = (value) => String(value ?? '').replace(PARAM_REF, (m, p) => (p in params ? params[p] : m))
  /** A URL the spec accepts (full http(s) URL or a whole defined parameter), or null */
  const httpUrl = (url) => {
    if (!url) return null
    const whole = url.match(WHOLE_PARAM)
    if (whole) {
      params[whole[1]] ??= ''
      return url
    }
    const resolved = resolveParams(url)
    return HTTP_URL.test(resolved) ? resolved : null
  }

  const placeholder = (name, what) => ({
    type: 'contentModifier',
    name,
    description: truncate(`REPLACE WITH ${what}`, 500),
    properties: [{ name: 'REPLACE_WITH', type: 'constant', value: truncate(what, 250) }],
    placeholder: what
  })

  // XSLT files travel as attachments; v1 has no XSLT step, so they are listed in resources
  const resources = []
  for (const m of parsed.mappings || []) {
    const name = XSL_NAME.test(m.fileName) ? m.fileName : `${identifier(m.fileName.replace(/\.xslt?$/i, ''), 'mapping')}.xsl`
    attachments[name] = m.content
    resources.push(name)
  }

  /** Spec steps for one parsed step (a Content Modifier with XPath rows becomes Groovy + Content Modifier) */
  function convert(s, { inException }) {
    const name = s.name ? truncate(s.name, 100) : undefined
    const label = s.name ? `'${s.name}'` : ''
    switch (s.type) {
      case 'contentModifier': {
        const dropped = []
        const xpaths = []
        const rows = (list = [], table) =>
          list.flatMap((r) => {
            if (r.action && r.action !== 'Create') return dropped.push(`${table} ${r.name} (action ${r.action})`), []
            if (!ROW_NAME.test(r.name || '')) return dropped.push(`${table} '${r.name}' (name not supported)`), []
            const keep = (type, value) => [{ name: r.name, type, value, ...(r.datatype && { datatype: r.datatype }) }]
            switch (r.type) {
              case 'constant':
              case 'expression':
                return keep(r.type, resolveParams(r.value))
              case 'header':
                return keep('expression', `\${header.${r.value}}`)
              case 'property':
                return keep('expression', `\${property.${r.value}}`)
              case 'xpath':
                return xpaths.push({ table, name: r.name, xpath: r.value || '' }), []
              default:
                return dropped.push(`${table} ${r.name} (source type ${r.type})`), []
            }
          })
        const cm = { type: 'contentModifier', ...(name && { name }) }
        const headers = rows(s.headers, 'header')
        const properties = rows(s.properties, 'property')
        if (headers.length) cm.headers = headers
        if (properties.length) cm.properties = properties
        if (s.body) cm.body = s.body
        if (dropped.length) cm.description = truncate(`REPLACE WITH ${dropped.join('; ')}: not supported by the spec, set them in the CPI web editor`, 500)
        const out = []
        if (xpaths.length) {
          const fileName = uniqueFile(`xpath_${identifier(s.name, 'values')}`, 50)
          attachments[`${fileName}.groovy`] = xpathGroovy(s.name || 'Content Modifier', xpaths)
          out.push({ type: 'groovyScript', name: `${name || 'Content Modifier'} XPath`, description: `XPath values of ${s.name || 'the Content Modifier'}, set in Groovy (generated on import)`, fileName })
          notes.push(`${s.name || 'A Content Modifier'}: ${xpaths.length} XPath value(s) moved into the generated script ${fileName}.groovy, which runs before it`)
        }
        if (headers.length || properties.length || cm.body || dropped.length || !xpaths.length) out.push(cm)
        return out
      }
      case 'groovyScript': {
        const file = (parsed.scripts || []).find((f) => f.fileName === `${s.fileName}.groovy`)
        if (!file) return [placeholder(name, `Groovy script ${label} (${s.script || 'file'} is missing in the export)`)]
        const fileName = uniqueFile(identifier(s.fileName, 'script'), 50)
        attachments[`${fileName}.groovy`] = file.content
        const step = { type: 'groovyScript', ...(name && { name }), fileName }
        if (s.function && s.function !== 'processData')
          step.description = `REPLACE WITH the entry function ${s.function}(): v1 calls processData(). Rename the function in ${fileName}.groovy or set it in the CPI web editor.`
        return [step]
      }
      case 'jsonToXml':
      case 'xmlToJson':
        return [{ type: s.type, ...(name && { name }) }]
      case 'requestReplyHttp': {
        if (inException) return [placeholder(name, `HTTP request-reply ${label} to ${s.url || '?'} (not supported in the exception subprocess)`)]
        const url = httpUrl(s.url)
        if (!url) return [placeholder(name, `HTTP request-reply ${label} to ${s.url || '?'} (the URL could not be converted)`)]
        const step = { type: 'requestReplyHttp', ...(name && { name }), system: uniqueSystem(identifier(s.system, 'Receiver'), 50), url, method: METHODS.includes(s.method) ? s.method : 'GET', authType: 'None' }
        if (s.authType && s.authType !== 'None')
          step.description = `Set authentication ${s.authType}${s.credentialAlias ? ` with credential ${s.credentialAlias}` : ''} on ${step.system} in the CPI web editor.`
        return [step]
      }
      case 'requestReply': {
        const a = s.adapter || {}
        return [placeholder(name, `request-reply ${label} via the ${a.type || 'unknown'} adapter${a.system ? ` to ${a.system}` : ''}${a.address ? ` (${a.address})` : ''}`)]
      }
      case 'router':
        return [placeholder(name, `Router ${label} (its branches were imported one after another)`)]
      case 'parallelMulticast':
        return [placeholder(name, `Parallel Multicast ${label} (its branches were imported one after another)`)]
      case 'script':
        return [placeholder(name, `${s.language || 'script'} step ${label} (${s.script || 'script'})`)]
      default:
        return [placeholder(name, `${words(s.activityType || s.type)} ${label}${/mapping/i.test(s.activityType || '') && resources.length ? ` (the XSLT files are included as resources)` : ''}`.replace(/\s+$/, ''))]
    }
  }

  // --- trigger -------------------------------------------------------------------------
  const id = identifier(parsed.id || (fileName || '').replace(/\.(zip|iflw)$/i, ''), 'Imported_iFlow', 100)
  const fallbackAddress = `/imported/${id.toLowerCase()}`
  const t = parsed.trigger || {}
  let trigger
  if (t.type === 'timer') {
    trigger = { type: 'timer', mode: 'once' }
    if (t.mode !== 'once') notes.push('Trigger: the timer schedule became "run once after deployment"; set the schedule in the CPI web editor')
  } else if (t.type === 'httpsSender') {
    const address = '/' + String(t.address || '').split('/').map((seg) => seg.replace(/[^A-Za-z0-9_.~-]/g, '-')).filter(Boolean).join('/')
    trigger = { type: 'httpsSender', address: address === '/' ? fallbackAddress : address }
    if (trigger.address !== t.address) notes.push(`Trigger: HTTPS address ${t.address || '(none)'} became ${trigger.address}`)
  } else {
    trigger = { type: 'httpsSender', address: fallbackAddress }
    notes.push(`Trigger: ${t.type === 'sender' ? `the ${t.adapter} sender` : 'the start event'} was replaced by an HTTPS sender at ${fallbackAddress}; set up the original sender in the CPI web editor`)
  }

  // --- steps -----------------------------------------------------------------------------
  let steps = (parsed.steps || []).flatMap((s) => convert(s, { inException: false }))
  if (!parsed.linear) notes.push('The flow branches: the steps of all branches were put one after another; check the order')
  if (parsed.localProcesses?.length) notes.push(`Local integration processes are not imported: ${parsed.localProcesses.join(', ')}`)

  // --- end -------------------------------------------------------------------------------
  const e = parsed.end || {}
  let end = { type: 'none' }
  if (e.type === 'httpReceiver') {
    const url = httpUrl(e.url)
    if (url) {
      end = { type: 'httpReceiver', system: uniqueSystem(identifier(e.system, 'Receiver'), 50), url, method: METHODS.includes(e.method) ? e.method : 'POST', authType: 'None' }
      if (e.authType && e.authType !== 'None') notes.push(`End receiver ${end.system}: set authentication ${e.authType}${e.credentialAlias ? ` with credential ${e.credentialAlias}` : ''} in the CPI web editor`)
    } else steps.push(placeholder(undefined, `the HTTP receiver ${e.system || ''} at ${e.url || '?'} (the URL could not be converted)`))
  } else if (e.type === 'receiver') steps.push(placeholder(undefined, `the ${e.adapter} receiver${e.system ? ` ${e.system}` : ''}${e.address ? ` (${e.address})` : ''}`))

  // --- exception subprocess ----------------------------------------------------------------
  let exceptionSubprocess
  if (parsed.exceptionSubprocess) {
    const subSteps = parsed.exceptionSubprocess.steps.flatMap((s) => convert(s, { inException: true }))
    if (subSteps.length) exceptionSubprocess = { ...(parsed.exceptionSubprocess.name && { name: truncate(parsed.exceptionSubprocess.name, 100) }), steps: subSteps }
    else notes.push('The exception subprocess has no steps and was left out (the spec needs at least one)')
  }

  // --- limits: merge consecutive placeholders, longest runs first ---------------------------
  const mergeRuns = (list, max, where) => {
    let out = list
    while (out.length > max) {
      const runs = []
      out.forEach((s, i) => (s.placeholder ? (i > 0 && out[i - 1].placeholder ? runs.at(-1).push(i) : runs.push([i])) : null))
      const run = runs.filter((r) => r.length > 1).sort((a, b) => b.length - a.length)[0]
      if (!run) break
      const parts = run.map((i) => out[i].placeholder)
      const merged = placeholder(out[run[0]].name, parts.join('; then '))
      out = [...out.slice(0, run[0]), merged, ...out.slice(run.at(-1) + 1)]
      notes.push(`${where}: ${run.length} consecutive placeholders were merged into one to stay within ${max} steps`)
    }
    if (out.length > max)
      throw fail('IMPORT_TOO_LARGE', `The ${where.toLowerCase()} has ${out.length} steps after merging placeholders; v1 builds at most ${max}.`, 'Split the iFlow, or remove steps before importing.')
    return out
  }
  steps = mergeRuns(steps, MAX_STEPS, 'Main flow')
  if (exceptionSubprocess) exceptionSubprocess.steps = mergeRuns(exceptionSubprocess.steps, MAX_EXCEPTION_STEPS, 'Exception subprocess')

  // --- unique names, placeholder markers removed ------------------------------------------------
  const finish = (s) => {
    const { placeholder: what, ...step } = s
    return { ...step, name: uniqueName(s.name || (what ? 'Placeholder' : step.type === 'groovyScript' ? 'Groovy Script' : step.type === 'contentModifier' ? 'Content Modifier' : words(step.type))) }
  }
  const placeholders = [...steps, ...(exceptionSubprocess?.steps || [])].filter((s) => s.placeholder).length
  steps = steps.map(finish)
  if (exceptionSubprocess) {
    exceptionSubprocess.steps = exceptionSubprocess.steps.map(finish)
    exceptionSubprocess.name = uniqueName(exceptionSubprocess.name || 'Exception Subprocess 1')
  }

  const description = truncate(`Imported from ${fileName}.${parsed.description ? ` ${parsed.description}` : ''}`, 1000)
  const spec = {
    id,
    name: truncate(parsed.name || id, 100),
    description,
    packageId: /^[A-Za-z0-9.]+$/.test(packageId || '') ? packageId : 'Imported',
    trigger,
    steps,
    end,
    ...(exceptionSubprocess && { exceptionSubprocess }),
    ...(Object.keys(params).length && { parameters: params }),
    ...(resources.length && { resources })
  }
  if (spec.packageId === 'Imported') notes.push('Target package: set one before proposing (session defaults or the proposal panel)')
  if (placeholders) notes.push(`${placeholders} placeholder step(s) say what to replace them with in the CPI web editor`)
  const { valid, errors } = validate(spec, { attachments: Object.keys(attachments) })
  return { spec, attachments, notes, placeholders, valid, errors }
}

module.exports = { importIflow, xpathGroovy }
