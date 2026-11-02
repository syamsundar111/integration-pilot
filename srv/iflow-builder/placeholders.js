/**
 * Placeholder steps: Content Modifiers whose description starts with REPLACE WITH (the AI's PH_ steps and Import's
 * placeholders). One check for the builder, the validator and the deploy block, so they agree on which steps are
 * placeholders. A step's description is not written into the iFlow, so the builder writes the note into the
 * REPLACE_WITH property, whatever the spec has there; the app does not deploy an iFlow that still has a placeholder.
 */
const specSteps = require('./spec-steps')

const PREFIX = /^REPLACE WITH\b\s*/
const PARAM_REF = /\{\{\s*([^}]*?)\s*\}\}/g
const MAX_NOTE = 250 // as Import writes it
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const isPlaceholder = (s) => s?.type === 'contentModifier' && typeof s.description === 'string' && PREFIX.test(s.description)
const hasReplaceWith = (s) => s?.type === 'contentModifier' && Array.isArray(s.properties) && s.properties.some((p) => p?.name === 'REPLACE_WITH')

/** The note CPI shows: the description without REPLACE WITH (a placeholder), else the REPLACE_WITH value; {{Param}} as {Param} */
function noteOf(s) {
  const text = isPlaceholder(s) ? s.description.replace(PREFIX, '') : String(s.properties.find((p) => p?.name === 'REPLACE_WITH')?.value ?? '')
  return truncate(text.trim().replace(PARAM_REF, '{$1}'), MAX_NOTE)
}

/** A note that says what to add: not empty, and not just the property's name */
const usable = (note) => !!note && !/^REPLACE[ _]WITH$/i.test(note)

/** Copy of the spec with each placeholder's note as its REPLACE_WITH property (in its place, or added; other properties stay) */
function withNotes(spec) {
  return specSteps.mapSteps(spec, (s) => {
    if (!isPlaceholder(s)) return s
    const note = { name: 'REPLACE_WITH', type: 'constant', value: noteOf(s) }
    const properties = s.properties || []
    return { ...s, properties: hasReplaceWith(s) ? properties.map((p) => (p?.name === 'REPLACE_WITH' ? note : p)) : [...properties, note] }
  })
}

/** The names of the placeholder steps (paths for steps without a name) */
const placeholderNames = (spec) => specSteps.allSteps(spec).filter((x) => isPlaceholder(x.step)).map((x) => x.step.name || x.where)

module.exports = { isPlaceholder, hasReplaceWith, noteOf, usable, withNotes, placeholderNames }
