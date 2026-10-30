/**
 * Spec values <-> the values CPI stores, for Content Modifier sources, Write Variables and timer
 * schedules (HTTP receivers: receiver-settings.js), and the check of stored values against the
 * reference exports (templates/reference-values.json, merged with reference/confirmed-values.json).
 */
const fs = require('fs')
const path = require('path')
const REFERENCE_VALUES = require('./templates/reference-values.json')

// Content Modifier source type: spec -> stored (the variable sources have other names in CPI)
const CM_SOURCE_TYPES = {
  constant: 'constant',
  expression: 'expression',
  header: 'header',
  property: 'property',
  xpath: 'xpath',
  globalVariable: 'global persisted variables',
  localVariable: 'persisted variables'
}
const cmTypeFromCpi = (stored) => Object.keys(CM_SOURCE_TYPES).find((k) => CM_SOURCE_TYPES[k] === stored)

// Write Variables: the types in the references; Global Scope checked = 'global'
const WV_TYPES = ['property', 'xpath']
const scopeOf = (variable) => (variable.global ? 'global' : 'local')

// Escalation End category (stored as is): the default 'Others' ("Others - not further qualified"); the others
// must be in the references and confirmed (receiver categories come when an interface needs them)
const DEFAULT_ESCALATION_CATEGORY = 'Others'

// Gather (XML, same format): Combine, or Combine at XPath with a source and target
const GATHER_COMBINE = 'sap-identical-multi-mapping'
const GATHER_AT_XPATH = 'xpath-merge-strategy'
const gatherAlgorithm = (gather) => (gather.source ? GATHER_AT_XPATH : GATHER_COMBINE)

// XPath values need a data type; java.lang.String as in the references (and the CPI editor's default)
const DEFAULT_XPATH_DATATYPE = 'java.lang.String'

// Timer start: the stored schedule (scheduleKey's schedule1), from templates/timer-schedules.json
const SCHEDULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'templates', 'timer-schedules.json'), 'utf8'))
const TIME_ZONE = 'Etc/GMT' // UTC, the only time zone in the references

/** The raw schedule1 text of a spec trigger { type: 'timer', mode, minutes } */
const scheduleOf = (trigger) => (trigger.mode === 'every' ? SCHEDULES.everyMinutes.replace('{{MINUTES}}', String(trigger.minutes)) : SCHEDULES.once)

/** A parsed schedule1 ("simple.repeat=MINUTES&simple.every=15&trigger.timeZone=Etc/GMT") -> { repeat, every, timeZone } */
function parseSchedule(schedule = '') {
  const get = (k) => String(schedule).match(new RegExp(`(?:^|&)${k.replace('.', '\\.')}=([^&]*)`))?.[1]
  return { repeat: get('simple.repeat'), every: get('simple.every'), timeZone: get('trigger.timeZone') }
}

/** The stored timer values of a spec trigger, as checked against the references */
const timerValues = (trigger) =>
  trigger.mode === 'every' ? [['repeat', 'MINUTES'], ['every', String(trigger.minutes)], ['timeZone', TIME_ZONE]] : [['repeat', 'NONE'], ['timeZone', TIME_ZONE]]

/**
 * Stored values of one component checked against the reference exports: { errors, warnings }. A value
 * no reference contains is an error; one seen only once and not re-selected in the CPI editor
 * (confirmed) is a warning.
 * @param {string} component - a key of reference-values.json, e.g. 'Content Modifier'
 * @param {[string, string][]} stored - [field, value] pairs as CPI stores them
 * @param {object} [values] - reference-values.json, for tests
 */
function checkValues(component, stored, where, values = REFERENCE_VALUES) {
  const errors = []
  const warnings = []
  for (const [field, value] of stored) {
    const seen = values[component]?.[field]
    if (!seen) continue // a field the references do not cover
    const entry = seen[value]
    if (!entry) errors.push(`${where}: ${field} '${value}' is in no reference export (known: ${Object.keys(seen).join(', ')})`)
    else if (entry.references.length === 1 && !entry.confirmed)
      warnings.push(`${where}: ${field} '${value}' is seen in only one reference export (${entry.references[0]}) and not yet confirmed in the CPI editor`)
  }
  return { errors, warnings }
}

module.exports = {
  CM_SOURCE_TYPES,
  cmTypeFromCpi,
  WV_TYPES,
  scopeOf,
  DEFAULT_XPATH_DATATYPE,
  DEFAULT_ESCALATION_CATEGORY,
  GATHER_COMBINE,
  GATHER_AT_XPATH,
  gatherAlgorithm,
  TIME_ZONE,
  scheduleOf,
  parseSchedule,
  timerValues,
  checkValues
}
