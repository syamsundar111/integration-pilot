sap.ui.define([], () => {
  'use strict'

  /**
   * Client-side checks of an iFlow request before it is sent (no LLM call): missing package,
   * trigger or authentication info, step kinds v1 cannot build, too many steps, and {{Param}}
   * references outside URLs. Each finding costs the user a clarification round or a failed
   * proposal, so they are shown as warnings with "Send anyway" / "Edit". A follow-up message is
   * checked together with the earlier ones and shows only what is new since the first message.
   */

  const MAX_STEPS = 50

  /** Fill-in template for the empty chat (replaces the starter prompts) */
  const TEMPLATE = [
    'Create an iFlow.',
    'Trigger: <timer, run once after deployment — or HTTPS sender with path, e.g. /orders/create>',
    'Steps (in order, at most 50):',
    '1. <step type and name, e.g. Content Modifier "Set Properties": property Source = constant Shop>',
    '2. <…>',
    'Receivers: <name, method and URL of each HTTP call; externalize a URL as {{Name}} with a default>',
    'Authentication: <None, or method and credential name per receiver>',
    'Package: <existing package id, or a new id (letters, digits, dots) and name>',
    'Error handling: <exception subprocess: what to set, log or return when a step fails>'
  ].join('\n')

  // Unfilled template fields
  const PLACEHOLDER = /<(timer, run once|step type and name|…|name, method and URL|None, or method|existing package id|exception subprocess:)[^>\n]*>/

  const BUILD_REQUEST = /\b(create|build|generate|design|make|propose|new)\b[\s\S]{0,80}\b(i-?flows?|integration flows?|flows?)\b/i
  const FLOW_CHANGE = /\b(create|build|generate|design|propose|add|insert|include|change|update|replace|extend)\b/i

  // Step kinds v1 does not build. Quoted text and code are ignored ("contains \"mapping\"" is data, not a step).
  const UNSUPPORTED = [
    ['router', /\b(content[- ]based )?router\b/i],
    ['splitter', /\bsplitter\b/i],
    ['gather', /\bgather\b/i],
    ['join', /\bjoin\b(?!\s+(to|with|on|by)\b)/i],
    ['multicast', /\bmulticast\b/i],
    ['XSLT', /\bxslt\b|\bxsl (mapping|transformation)\b/i],
    ['mapping', /\b(message|graphical|operation|xml|edmx)\s+mapping\b|\bmapping\s+(step|artifact)\b|\b(an?|add|use|via|with)\s+(an?\s+)?mapping\b/i],
    ['SFTP', /\bsftp\b/i],
    ['write variables', /\bwrite variables?\b/i],
    ['process call', /\b(local )?process call\b/i]
  ]

  const PACKAGE = /\bpackages?\b/i
  const TRIGGER = /\b(timer|scheduled?|run once|cron|https(?!:\/\/)|http sender|sender|endpoint|called via|trigger(ed)?)\b/i
  const CALLS_RECEIVER = /https?:\/\/|\{\{|\breceivers?\b|\brequest[- ]reply\b|\b(post|put|patch|send)s?\b[^.\n]{0,60}\b(to|url|endpoint|api)\b/i
  const AUTH = /\b(auth\w*|oauth\w*|basic|credentials?|certificates?|api[- ]?keys?|saml|bearer|no auth)\b/i

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
      `Not supported in v1: ${found.join(', ')}. Flows are linear (Content Modifier, Groovy Script, JSON/XML converters, HTTP request-reply). Use a Groovy script, or add the step in the CPI web editor after creation.` +
      (found.includes('XSLT') ? ' Attach the .xsl file to include it in the iFlow, ready for an XSLT Mapping step.' : ''),
    params: (names) => `${names.join(', ')}: parameters work only as the whole URL of an HTTP receiver. Use literal values elsewhere.`
  }

  /**
   * Findings as { key, message, items? }. Missing info and unsupported steps are checked in the
   * conversation (all user messages so far); the template, step count and parameters only in the
   * message being sent.
   */
  function findings(conversation, message, defaults, draft) {
    const warnings = []
    const warn = (key, msg, items) => warnings.push({ key, message: msg, ...(items && { items }) })

    // the session default package overrides the message
    const named = defaults.packageId ? null : (message.match(PACKAGE_QUOTED) || message.match(PACKAGE_WORD) || [])[1]
    const pkg = toPackageId(named)
    if (pkg.name) {
      if (pkg.id) warnings.push({ key: 'packageId', level: 'info', message: pkg.note })
      else warn('packageId', `Package "${pkg.name}" has no letters or digits for a package ID. Name the package with letters, digits or dots.`)
    }

    if (PLACEHOLDER.test(message)) warn('template', 'Some template fields are still unfilled (text in <…>). Fill them in or delete those lines.')

    const isBuild = BUILD_REQUEST.test(conversation)
    if (!isBuild && !FLOW_CHANGE.test(message)) return warnings

    if (isBuild) {
      // a draft spec (e.g. an imported iFlow) has a trigger and a package; the proposal panel can change the package
      if (!PACKAGE.test(conversation) && !defaults.packageId && !(draft && draft.packageId))
        warn('package', 'No target package. Name an existing package id, or a new id (letters, digits, dots) and name — or set it in the session defaults.')
      if (!TRIGGER.test(conversation) && !defaults.timer && !(draft && draft.trigger))
        warn('trigger', 'No trigger. Say whether the flow runs once on a timer or is called via HTTPS (with the path) — or set the timer in the session defaults.')
      if (CALLS_RECEIVER.test(conversation) && !AUTH.test(conversation) && !defaults.authNote)
        warn('auth', 'No authentication info for the receivers. Say "no authentication", or the method and credential name — or add an auth note in the session defaults.')
    }

    const found = unsupportedIn(conversation)
    if (found.length) warn('unsupported', WARNINGS.unsupported(found), found)

    const steps = estimateSteps(message)
    if (steps > MAX_STEPS) warn('steps', `About ${steps} steps — v1 allows at most ${MAX_STEPS} in the main flow. Merge Content Modifiers or move logic into one Groovy script.`)

    const outside = stripQuoted(message)
      .split('\n')
      .filter((l) => /\{\{[^}]*\}\}/.test(l) && !/\burls?\b|https?:\/\//i.test(l))
      .flatMap((l) => l.match(/\{\{[^}]*\}\}/g))
    if (outside.length) warn('params', WARNINGS.params([...new Set(outside)]), [...new Set(outside)])

    return warnings
  }

  /**
   * @param {string} text - the message about to be sent
   * @param {{ defaults?: { packageId?: string, timer?: string, authNote?: string }, history?: string[], draft?: { trigger?: boolean, packageId?: string } }} [options]
   *   history: the earlier user messages of the conversation, oldest first. On a follow-up only the
   *   warnings that are new compared with the first message are returned.
   *   draft: the conversation's draft spec (e.g. an imported iFlow): its trigger and package count as given.
   * @returns {{ key: string, level?: 'info', message: string }[]} warnings, [] if fine; level 'info'
   *   is information only (e.g. the package ID derived from a Name) and needs no confirmation
   */
  function lint(text, { defaults = {}, history = [], draft = null } = {}) {
    const message = String(text || '')
    const past = history.map((m) => String(m || '')).filter((m) => m.trim())
    const current = findings([...past, message].join('\n\n'), message, defaults, draft)
    const strip = ({ key, level, message: msg }) => ({ key, ...(level && { level }), message: msg })
    if (!past.length) return current.map(strip)

    const first = findings(past[0], past[0], defaults, draft)
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
