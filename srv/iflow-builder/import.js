/**
 * Import: any CPI iFlow (zip export or a bare .iflw) -> draft iFlow spec v1.
 *
 * Unlike to-spec.js, which must be exact because an update rebuilds the iFlow, import
 * approximates and does not refuse: what the spec cannot build becomes a placeholder Content
 * Modifier whose description (and REPLACE_WITH property) says what to put there in the CPI web
 * editor. A branching flow keeps only its main path (at each router the route with a condition);
 * the other routes are described in the router's placeholder. Consecutive placeholders are merged
 * if the flow would exceed 50 steps, names are made unique, XPath values of Content Modifiers move
 * into a generated Groovy script, and {{Param}} references outside receiver URLs become the
 * parameter's default value.
 * Groovy scripts, XSLT files and the generated scripts are returned as attachments, so the
 * spec references them by file name and the model never sees their content.
 */
const JSZip = require('jszip')
const { parse } = require('./parser')
const cpiValues = require('./cpi-values')
const { validate } = require('./validator')

const MAX_STEPS = 50
const MAX_EXCEPTION_STEPS = 10
const IFLOW_DIR = 'src/main/resources/scenarioflows/integrationflow/'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const HTTP_URL = /^https?:\/\/\S+$/
const WHOLE_PARAM = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/
const PARAM_REF = /\{\{\s*([^}]*?)\s*\}\}/g
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const ROW_NAME = /^[A-Za-z0-9_.-]+$/
const XSL_NAME = /^[A-Za-z][A-Za-z0-9_.-]*\.xslt?$/
const INLINE_TYPES = ['contentModifier', 'groovyScript', 'jsonToXml', 'xmlToJson'] // steps of a local process copied into error handling

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
  const resources = []
  for (const m of parsed.mappings || []) {
    const name = XSL_NAME.test(m.fileName) ? m.fileName : `${identifier(m.fileName.replace(/\.xslt?$/i, ''), 'mapping')}.xsl`
    attachments[name] = m.content
    resources.push(name)
  }

  // Local processes a Process Call may run: by processId, else the only one there is
  const locals = parsed.localProcessSteps || []
  const inlined = new Set() // local processes copied into the exception subprocess
  const localProcessOf = (s) => locals.find((l) => l.id === s.processId) || (locals.length === 1 ? locals[0] : null)

  /** Spec steps for one parsed step (a Content Modifier with XPath rows becomes Groovy + Content Modifier) */
  function convert(s, { inException }) {
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
            return [{ name: r.name, type, value, ...(r.datatype && { datatype: r.datatype }), ...(r.default && { default: r.default }) }]
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
        return [cm]
      }
      case 'writeVariables': {
        if (inException) return [placeholder(name, `Write Variables ${label}: ${s.variables.map((v) => `${v.name} = ${v.value} (${v.type})`).join(', ')} (not supported in the exception subprocess)`)]
        const variables = s.variables.filter((v) => cpiValues.WV_TYPES.includes(v.type) && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(v.name || '') && v.value)
        if (!variables.length) return [placeholder(name, `Write Variables ${label}: ${s.variables.map((v) => `${v.name} (${v.type})`).join(', ')}`)]
        const step = {
          type: 'writeVariables',
          ...(name && { name }),
          variables: variables.map((v) => ({ name: v.name, type: v.type, value: v.value, ...(v.datatype && { datatype: v.datatype }), ...(v.global && { global: true }) }))
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
          step.description = `REPLACE WITH the entry function ${s.function}(): v1 calls processData(). Rename the function in ${fileName}.groovy or set it in the CPI web editor.`
        return [step]
      }
      case 'jsonToXml':
      case 'xmlToJson':
        return [{ type: s.type, ...(name && { name }) }]
      case 'requestReplyHttp': {
        if (inException) return [placeholder(name, `HTTP request-reply ${label} to ${s.url || '?'} (not supported in the exception subprocess)`)]
        const system = uniqueSystem(identifier(s.system, 'Receiver'), 50)
        const url = httpUrl(s.url, system)
        if (!url) return [placeholder(name, `HTTP request-reply ${label} to ${s.url || '?'} (the URL could not be converted)`)]
        const step = { type: 'requestReplyHttp', ...(name && { name }), system, url, method: METHODS.includes(s.method) ? s.method : 'GET', ...receiverFields(s, system) }
        if (s.unsupportedSettings?.length) step.description = `Set ${s.unsupportedSettings.map(withDefaults).join(', ')} on ${system} in the CPI web editor.`
        return [step]
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
        // in error handling, a called process of Content Modifiers and Groovy runs as the subprocess's own steps
        if (inException && lip && lip.linear && lip.steps.length && lip.steps.every((x) => INLINE_TYPES.includes(x.type))) {
          const inner = lip.steps.flatMap((x) => convert(x, { inException }))
          inlined.add(lip.name)
          notes.push(`${s.name || 'Process Call'}: the steps of the local process ${lip.name} were copied into the exception subprocess (${inner.map((x) => x.name).filter(Boolean).join(', ')})`)
          return inner
        }
        return [placeholder(name, `Process Call ${label}${lip ? ` to the local process '${lip.name}'` : ''}`)]
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
    trigger = { type: 'httpsSender', address: fallbackAddress }
    notes.push(`Trigger: ${t.type === 'sender' ? `the ${t.adapter} sender` : 'the start event'} was replaced by an HTTPS sender at ${fallbackAddress}; set up the original sender in the CPI web editor`)
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
  const routerOf = (r) => ({
    type: 'router',
    ...(r.name && { name: truncate(r.name, 100) }),
    expressionType: r.expressionType || 'NonXML',
    routes: r.routes.map((route) => {
      if (route.end && !['message', 'escalation', 'error'].includes(route.end.kind)) notes.push(`${r.name}, route ${route.name}: a ${route.end.kind} end became a Message End; set it in the CPI web editor`)
      const steps_ = route.steps.flatMap((x) => convert(x, { inException: false }))
      return {
        name: truncate(route.name, 100),
        ...(route.default ? { default: true } : { condition: spacedCondition(withDefaults(route.condition), r.expressionType) }),
        ...(steps_.length && { steps: steps_ }),
        ...(route.end && { end: routeEnd(route.end, `${r.name}, route ${route.name}`) })
      }
    })
  })
  let steps = routed
    ? routed.steps.flatMap((s) => (s.type === 'router' ? [routerOf(s)] : convert(s, { inException: false })))
    : (branching ? branching.steps : parsed.steps || []).flatMap((s) => convert(s, { inException: false }))
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
  } else if (e.type === 'receiver') steps.push(placeholder(undefined, `the ${e.adapter} receiver${e.system ? ` ${e.system}` : ''}${e.address ? ` (${e.address})` : ''}`))

  // --- exception subprocess ----------------------------------------------------------------
  let exceptionSubprocess
  if (parsed.exceptionSubprocess) {
    const subSteps = parsed.exceptionSubprocess.steps.flatMap((s) => convert(s, { inException: true }))
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

  const notImported = (parsed.localProcesses || []).filter((n) => !inlined.has(n))
  if (notImported.length) notes.push(`Local integration processes are not imported: ${notImported.join(', ')}`)
  if ((parsed.integrationProcesses?.length || 0) > 1)
    notes.push(`Only the integration process "${parsed.integrationProcesses[0]}" was imported; not imported: ${parsed.integrationProcesses.slice(1).join(', ')}`)
  else if (parsed.warnings?.length) notes.push(...parsed.warnings)

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
  // routers and the steps inside routes count towards the limit; only main-line placeholders are merged
  const inRoutes = steps.filter((s) => s.type === 'router').reduce((n, r) => n + r.routes.reduce((m, x) => m + (x.steps?.length || 0), 0), 0)
  steps = mergeRuns(steps, MAX_STEPS - inRoutes, 'Main flow')
  if (exceptionSubprocess) exceptionSubprocess.steps = mergeRuns(exceptionSubprocess.steps, MAX_EXCEPTION_STEPS, 'Exception subprocess')

  // --- unique names, placeholder markers removed ------------------------------------------------
  const finish = (s) => {
    const { placeholder: what, ...step } = s
    return { ...step, name: uniqueName(s.name || (what ? 'Placeholder' : step.type === 'groovyScript' ? 'Groovy Script' : step.type === 'contentModifier' ? 'Content Modifier' : words(step.type))) }
  }
  const routeSteps = steps.filter((s) => s.type === 'router').flatMap((r) => r.routes.flatMap((x) => x.steps || []))
  const placeholders = [...steps, ...routeSteps, ...(exceptionSubprocess?.steps || [])].filter((s) => s.placeholder).length
  steps = steps.map((s) => (s.type === 'router' ? { ...finish(s), routes: s.routes.map((x) => (x.steps ? { ...x, steps: x.steps.map(finish) } : x)) } : finish(s)))
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
  if (spec.packageId === 'Imported') notes.push('Target package: set one before proposing (in your message or in the proposal panel)')
  if (placeholders) notes.push(`${placeholders} placeholder step(s) say what to replace them with in the CPI web editor`)
  const { valid, errors } = validate(spec, { attachments: Object.keys(attachments) })
  return { spec, attachments, notes, placeholders, valid, errors }
}

module.exports = { importIflow }
