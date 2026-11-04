sap.ui.define([], () => {
  'use strict'

  /**
   * Client-side checks of an iFlow request before it is sent (no LLM call): step kinds v1 cannot
   * build, too many steps, unfilled template fields, a package name without a valid ID, {{Param}}
   * references outside receiver URLs, credential names and location IDs, and passwords or secrets
   * (credential names only); a missing package, trigger or authentication gets a default instead. Each finding costs the user a clarification round or a failed
   * proposal, so they are shown as warnings with "Send anyway" / "Edit". A follow-up message is
   * checked together with the earlier ones and shows only what is new since the first message.
   */

  const MAX_STEPS = 50

  /** Fill-in template for the empty chat (replaces the starter prompts). Trigger, package and
   * authentication are left out: the assistant defaults them (HTTPS, first package, none) */
  const TEMPLATE = [
    'Create an iFlow.',
    'Steps (in order, at most 50):',
    '1. <step type and name, e.g. Content Modifier "Set Properties": property Source = constant Shop>',
    '2. <…>',
    'Receivers: <name, method and URL of each HTTP call; externalize a URL as {{Name}} with a default; authentication None, or Basic / OAuth2 Client Credentials with the credential name; On-Premise with the location ID if needed>',
    'Error handling: <exception subprocess: what to set, log or return when a step fails>'
  ].join('\n')

  // Unfilled template fields
  const PLACEHOLDER = /<(step type and name|…|name, method and URL|exception subprocess:)[^>\n]*>/

  const BUILD_REQUEST = /\b(create|build|generate|design|make|propose|new)\b[\s\S]{0,80}\b(i-?flows?|integration flows?|flows?)\b/i
  const FLOW_CHANGE = /\b(create|build|generate|design|propose|add|insert|include|change|update|replace|extend)\b/i

  // Step kinds v1 does not build. Quoted text and code are ignored ("contains \"mapping\"" is data, not a step).
  const UNSUPPORTED = [
    ['content enricher', /\bcontent enricher\b/i],
    ['poll enrich', /\bpoll enrich\b/i]
  ]

  // A password, secret or token value in the message (a credential *name* is fine: "credential ERP_BASIC_USER")
  const SECRET_VALUE = [
    /\b(password|passwd|pwd|passcode)\s*[:=]\s*\S+/i,
    /\b(client[ _-]?secret|api[ _-]?key|access[ _-]?token|token|secret)\s*[:=]\s*\S{6,}/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/,
    /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/i
  ]

  // Where a {{Param}} can stand: a receiver URL (a line about a URL, or right after an HTTP method or
  // "address"), a receiver's credential name or location ID, a mail's server or recipients, an SFTP sender's or receiver's
  // host, directory, file name or archive directory, or a constant
  // value ("constant {{X}}", "externalized parameter {{X}}", "server externalized as {{X}}")
  const URL_LINE = /\burls?\b|https?:\/\//i
  const PARAM_POSITION =
    /(\b(GET|POST|PUT|PATCH|DELETE)(\s+to)?|\b(address|url|endpoint)\s*[:=]?|\bcredential(\s+name)?\s*[:=]?|\blocation(\s+id)?\s*[:=]?|\bserver\s*[:=]?|\b(mail\s+to|recipients?)\s*[:=]?|\b(host|directory|file\s*name|archive(\s+directory)?)\s*[:=]?|\bto\s+externalized\s+as|\bconstant\s*[:=]?|\bparameter)(\s+externalized\s+as)?\s*$/i
  // Never, even on a URL line: right after user or password (credentials are names only), or part of a URL
  const NOT_PARAM_FIELD = /\b(user(\s*name)?|password)\s*[:=]?\s*$/i
  const IN_URL = (before, after) => /(:\/\/|\/)$/.test(before) || after.startsWith('/')

  // Quoted text is data or a description, not a step: "REPLACE WITH Router ..." may span lines (up to 600 characters)
  const stripQuoted = (text) => text.replace(/`[^`]{0,600}`/g, ' ').replace(/"[^"]{0,600}"/g, ' ').replace(/'[^'\n]*'/g, ' ')

  // Package ID vs Name, as in CPI (same logic as srv/lib/package-id.js): the ID keeps letters, digits and dots
  const PACKAGE_ID = /^[A-Za-z0-9.]+$/
  function toPackageId(value) {
    const v = String(value == null ? '' : value).trim()
    if (!v || PACKAGE_ID.test(v)) return { id: v, name: null, note: null }
    const id = v.replace(/[^A-Za-z0-9.]/g, '')
    const kinds = [v.includes('_') && 'underscores', /\s/.test(v) && 'spaces', /[^A-Za-z0-9._\s]/.test(v) && 'special characters'].filter(Boolean)
    const removed = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}` : kinds[0]
    return { id, name: v, note: id ? `Package ID will be ${id} (CPI does not allow ${removed} in IDs).` : null }
  }

  // The package the message names: quoted ("package \"My Test_Package\""), or one word with an underscore (package test_1)
  // "package" as a word: "packagename = DEV_SF" is a data value, not the target package
  const PACKAGE_QUOTED = /\bpackage\b\s*(?:(?:id|name|named|called)\b)?\s*[:=]?\s*["“'`]([^"”'`\n]{1,80})["”'`]/i
  const PACKAGE_WORD = /\bpackage\b\s*(?:(?:id|name|named|called)\b)?\s*[:=]?\s*([A-Za-z0-9.-]*_[A-Za-z0-9._-]*)/i

  /** Rough main-flow step count: numbered list items, minus start/end events */
  function estimateSteps(text) {
    return text
      .split('\n')
      .filter((l) => /^\s*\d+[.)]\s+/.test(l))
      .filter((l) => !/^\s*\d+[.)]\s+(timer\b|\S*\s*(start|end) event\b|end\b)/i.test(l)).length
  }

  // A step named after one of these is one the user does not want: "skip the splitter and SFTP", "without a router"
  const NEGATION = /\b(skip(ping)?|without|instead of|omit(ting)?|leave out|drop(ping)?|exclude)\b/i
  const NEGATION_NEAR = /\b(no|not)\s+(\w+\s+)?$/i // "no router", "no general splitter"
  // a new clause ends the negation: "without auth, but use a router", "no auth, then a splitter"
  const CLAUSE = /^[\s\S]*(\bbut\b|\bthen\b|\bhowever\b|,\s*(use|add|with)\b)/i

  /** Unsupported step kinds mentioned (not negated) in the text */
  function unsupportedIn(text) {
    const plain = stripQuoted(text)
    return UNSUPPORTED.filter(([, re]) =>
      [...plain.matchAll(new RegExp(re.source, 'gi'))].some((m) => {
        const before = plain.slice(0, m.index).split(/[.;!?\n]/).pop().replace(CLAUSE, '')
        return !NEGATION.test(before) && !NEGATION_NEAR.test(before)
      })
    ).map(([name]) => name)
  }

  const WARNINGS = {
    unsupported: (found) =>
      `Not supported yet: ${found.join(', ')}. Supported: Content Modifier, Groovy Script, Write Variables, JSON/XML converters, HTTP and SOAP request-reply, mail, mappings, routers, multicasts, splitters, gathers and process calls. Use a Groovy script, or add the step in the CPI web editor after creation.`,
    params: (names) =>
      `${names.join(', ')}: parameters work only as the whole URL, credential name or location ID of an HTTP receiver, the URL of a SOAP receiver, the server, credential name or recipients of a mail, the host, directory, file name, credential name or archive directory of an SFTP sender, the host, directory, file name or credential name of an SFTP receiver, or as a constant value. Use literal values elsewhere.`,
    secret:
      'This looks like a password, secret or token. Never send credentials: deploy them as security material in CPI (User Credentials or OAuth2 Client Credentials) and give only its name, e.g. "Basic, credential ERP_BASIC_USER".'
  }

  /**
   * Findings as { key, message, items? }. Unsupported steps are checked in the
   * conversation (all user messages so far); the template, step count and parameters only in the
   * message being sent.
   */
  function findings(conversation, message) {
    const warnings = []
    const warn = (key, msg, items) => warnings.push({ key, message: msg, ...(items && { items }) })

    const named = (message.match(PACKAGE_QUOTED) || message.match(PACKAGE_WORD) || [])[1]
    const pkg = toPackageId(named)
    if (pkg.name) {
      if (pkg.id) warnings.push({ key: 'packageId', level: 'info', message: pkg.note })
      else warn('packageId', `Package "${pkg.name}" has no letters or digits for a package ID. Name the package with letters, digits or dots.`)
    }

    if (PLACEHOLDER.test(message)) warn('template', 'Some template fields are still unfilled (text in <…>). Fill them in or delete those lines.')
    if (SECRET_VALUE.some((re) => re.test(message))) warn('secret', WARNINGS.secret)

    // a missing package, trigger or authentication is no warning: the assistant uses defaults
    // (first package on the tenant, HTTPS trigger, no authentication) and says so
    if (!BUILD_REQUEST.test(conversation) && !FLOW_CHANGE.test(message)) return warnings

    const found = unsupportedIn(conversation)
    if (found.length) warn('unsupported', WARNINGS.unsupported(found), found)

    const steps = estimateSteps(message)
    if (steps > MAX_STEPS) warn('steps', `About ${steps} steps — at most ${MAX_STEPS} steps per process are allowed. Merge Content Modifiers or move logic into one Groovy script.`)

    // {{…}} is fine as a whole receiver URL (on a line about a URL, or right after "GET", "POST to",
    // "address") and as a credential name or location ID; never after user or password, and never as part
    // of a URL ("https://{{Host}}/api"): only a whole value can be a parameter
    const outside = stripQuoted(message)
      .split('\n')
      .flatMap((l) =>
        [...l.matchAll(/\{\{[^}]*\}\}/g)]
          .filter((m) => {
            const before = l.slice(0, m.index)
            const after = l.slice(m.index + m[0].length)
            if (NOT_PARAM_FIELD.test(before) || IN_URL(before, after)) return true
            return !URL_LINE.test(l) && !PARAM_POSITION.test(before)
          })
          .map((m) => m[0])
      )
    if (outside.length) warn('params', WARNINGS.params([...new Set(outside)]), [...new Set(outside)])

    return warnings
  }

  /**
   * @param {string} text - the message about to be sent
   * @param {{ history?: string[] }} [options]
   *   history: the earlier user messages of the conversation, oldest first. On a follow-up only the
   *   warnings that are new compared with the first message are returned.
   * @returns {{ key: string, level?: 'info', message: string }[]} warnings, [] if fine; level 'info'
   *   is information only (e.g. the package ID derived from a Name) and needs no confirmation
   */
  function lint(text, { history = [] } = {}) {
    const message = String(text || '')
    const past = history.map((m) => String(m || '')).filter((m) => m.trim())
    const current = findings([...past, message].join('\n\n'), message)
    const strip = ({ key, level, message: msg }) => ({ key, ...(level && { level }), message: msg })
    if (!past.length) return current.map(strip)

    const first = findings(past[0], past[0])
    return current
      .flatMap((w) => {
        const before = first.find((f) => f.key === w.key)
        if (!before) return [w]
        const fresh = (w.items || []).filter((i) => !before.items.includes(i))
        return fresh.length ? [{ key: w.key, message: WARNINGS[w.key](fresh) }] : []
      })
      .map(strip)
  }

  return { lint, estimateSteps, toPackageId, TEMPLATE, MAX_STEPS }
})
