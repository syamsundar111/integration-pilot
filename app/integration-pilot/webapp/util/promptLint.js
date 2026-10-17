sap.ui.define([], () => {
  'use strict'

  /**
   * Client-side checks of an iFlow request before it is sent (no LLM call): missing package,
   * trigger or authentication info, step kinds v1 cannot build, too many steps, and {{Param}}
   * references outside URLs. Each finding costs the user a clarification round or a failed
   * proposal, so they are shown as warnings with "Send anyway" / "Edit".
   */

  const MAX_STEPS = 25

  /** Fill-in template for the empty chat (replaces the starter prompts) */
  const TEMPLATE = [
    'Create an iFlow.',
    'Trigger: <timer, run once after deployment — or HTTPS sender with path, e.g. /orders/create>',
    'Steps (in order, at most 25):',
    '1. <step type and name, e.g. Content Modifier "Set Properties": property Source = constant SF>',
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

  const stripQuoted = (text) => text.replace(/`[^`\n]*`/g, ' ').replace(/"[^"\n]*"/g, ' ').replace(/'[^'\n]*'/g, ' ')

  /** Rough main-flow step count: numbered list items, minus start/end events */
  function estimateSteps(text) {
    return text
      .split('\n')
      .filter((l) => /^\s*\d+[.)]\s+/.test(l))
      .filter((l) => !/^\s*\d+[.)]\s+(timer\b|\S*\s*(start|end) event\b|end\b)/i.test(l)).length
  }

  /**
   * @param {string} text - the message about to be sent
   * @param {{ defaults?: { packageId?: string, timer?: string, authNote?: string } }} [options]
   * @returns {{ key: string, message: string }[]} warnings, [] if fine
   */
  function lint(text, { defaults = {} } = {}) {
    const message = String(text || '')
    const warnings = []
    const warn = (key, msg) => warnings.push({ key, message: msg })

    if (PLACEHOLDER.test(message)) warn('template', 'Some template fields are still unfilled (text in <…>). Fill them in or delete those lines.')

    const isBuild = BUILD_REQUEST.test(message)
    if (!isBuild && !FLOW_CHANGE.test(message)) return warnings

    if (isBuild) {
      if (!PACKAGE.test(message) && !defaults.packageId)
        warn('package', 'No target package. Name an existing package id, or a new id (letters, digits, dots) and name — or set it in the session defaults.')
      if (!TRIGGER.test(message) && !defaults.timer)
        warn('trigger', 'No trigger. Say whether the flow runs once on a timer or is called via HTTPS (with the path) — or set the timer in the session defaults.')
      if (CALLS_RECEIVER.test(message) && !AUTH.test(message) && !defaults.authNote)
        warn('auth', 'No authentication info for the receivers. Say "no authentication", or the method and credential name — or add an auth note in the session defaults.')
    }

    const plain = stripQuoted(message)
    const found = UNSUPPORTED.filter(([, re]) => re.test(plain)).map(([name]) => name)
    if (found.length)
      warn(
        'unsupported',
        `Not supported in v1: ${found.join(', ')}. Flows are linear (Content Modifier, Groovy Script, JSON/XML converters, HTTP request-reply). Use a Groovy script, or add the step in the CPI web editor after creation.` +
          (found.includes('XSLT') ? ' Attach the .xsl file to include it in the iFlow, ready for an XSLT Mapping step.' : '')
      )

    const steps = estimateSteps(message)
    if (steps > MAX_STEPS) warn('steps', `About ${steps} steps — v1 allows at most ${MAX_STEPS} in the main flow. Merge Content Modifiers or move logic into one Groovy script.`)

    const outside = message
      .split('\n')
      .filter((l) => /\{\{[^}]*\}\}/.test(l) && !/\burls?\b|https?:\/\//i.test(l))
      .flatMap((l) => l.match(/\{\{[^}]*\}\}/g))
    if (outside.length)
      warn('params', `${[...new Set(outside)].join(', ')}: parameters work only as the whole URL of an HTTP receiver. Use literal values elsewhere.`)

    return warnings
  }

  return { lint, estimateSteps, TEMPLATE, MAX_STEPS }
})
