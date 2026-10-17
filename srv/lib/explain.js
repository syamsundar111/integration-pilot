/**
 * "Explain" for an existing iFlow (by id) or an uploaded zip: parses the iFlow
 * structurally, then asks the LLM for a short explanation. If the LLM is unavailable
 * the parsed summary is still returned, with the error, so the UI can show the diagram.
 */
const cds = require('@sap/cds')
const cpi = require('./cpi-client')
const llm = require('./llm')
const { parse } = require('../iflow-builder/parser')

const LOG = cds.log('explain')
const MAX_SCRIPT_CHARS = 3000

const SYSTEM = `You are a senior SAP Cloud Integration architect. Explain the given integration flow
(provided as a JSON summary parsed from the iFlow) for an integration developer.
Use concise Markdown with these sections: **Purpose** (1-2 sentences), **Flow** (numbered: trigger,
each step in order, receivers), **Configuration** (externalized parameters, authentication as configured),
**Notes** (risks or improvements, e.g. missing error handling, hard-coded values; omit if none).
Only describe what the summary contains; do not invent steps. Keep it under 250 words.`

/** @returns {Promise<object>} parser output */
async function parsedIflow({ iflowId, zipBase64 }) {
  if (zipBase64) return parse(zipBase64)
  if (iflowId) return parse(await cpi.downloadIflowZip(iflowId))
  throw Object.assign(new Error('Provide iflowId or zipBase64'), { status: 400, code: 'BAD_REQUEST' })
}

/**
 * @returns {Promise<{ summary: object, explanation: string|null, model: string|null, error: object|null }>}
 */
async function explain({ iflowId, zipBase64 }) {
  const summary = await parsedIflow({ iflowId, zipBase64 })
  const forModel = {
    ...summary,
    files: undefined,
    scripts: summary.scripts.map((s) => ({ ...s, content: s.content.length > MAX_SCRIPT_CHARS ? s.content.slice(0, MAX_SCRIPT_CHARS) + '\n// … truncated' : s.content }))
  }
  try {
    const res = await llm.chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Explain this iFlow:\n\n\`\`\`json\n${JSON.stringify(forModel, null, 1)}\n\`\`\`` }
      ],
      temperature: 0.2,
      maxTokens: 4096
    })
    return { summary, explanation: res.choices[0].message.content || null, model: res.model, error: null }
  } catch (e) {
    LOG.warn('AI explanation failed:', e.code, e.message)
    return { summary, explanation: null, model: null, error: { code: e.code, message: e.message, hint: e.hint } }
  }
}

module.exports = { explain, parsedIflow }
