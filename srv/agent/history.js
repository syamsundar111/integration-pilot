/**
 * What the model gets back of a conversation. The full history stays in the database; the
 * model gets:
 * - earlier turns as user message + final answer only: their tool calls and tool outputs are
 *   dropped (the Context section carries what matters: proposals, defaults, attachments and
 *   the latest spec, which is kept as session state);
 * - spec JSON pasted into earlier answers replaced by a note;
 * - within the running turn, only the newest copy of the spec: older copies in tool arguments
 *   (validateSpec, proposeIflow…) and tool outputs (getIflowSpec, getDraftSpec) are replaced,
 *   and only the newest version of each script written with writeScript.
 */

const SPEC_IN_ARGS = new Set(['validateSpec', 'proposeIflow', 'proposeIflowUpdate'])
const SPEC_IN_RESULT = new Set(['getIflowSpec', 'getDraftSpec'])
const OMITTED = '(older spec omitted: a newer version follows; getDraftSpec returns the latest)'
const SCRIPT_OMITTED = '(older version omitted: a newer writeScript of this file follows)'
const SPEC_BLOCK = /```[a-z]*\n([\s\S]*?)```/g

const parse = (s) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s || {}
  } catch {
    return null
  }
}

/** Tool arguments that carry a spec: { spec } or an unwrapped spec ({ id, steps, … }) */
const carriesSpec = (args) => !!args && (args.spec != null || !!(args.steps || args.trigger))

/** Assistant text with spec-like JSON code blocks replaced by a note */
function omitSpecBlocks(text) {
  if (typeof text !== 'string' || !text.includes('```')) return text
  return text.replace(SPEC_BLOCK, (block, body) => (body.length > 500 && /"steps"\s*:/.test(body) && /"trigger"\s*:/.test(body) ? '```\n(spec JSON omitted; the proposal panel shows it)\n```' : block))
}

/** Earlier turns for the model: user messages and final answers, without tool exchanges */
function pastTurns(messages) {
  return messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)).map((m) => (m.role === 'assistant' ? { ...m, content: omitSpecBlocks(m.content) } : m))
}

/** The running turn with every spec copy and script version except the newest replaced (the turn itself is not changed) */
function compactTurn(turn) {
  const toolName = {}
  const copies = [] // { i, j? }: j = index of the tool call within an assistant message
  const scripts = {} // fileName -> [{ i, j }] of writeScript calls
  turn.forEach((m, i) => {
    if (m.tool_calls)
      m.tool_calls.forEach((tc, j) => {
        toolName[tc.id] = tc.function.name
        if (SPEC_IN_ARGS.has(tc.function.name) && carriesSpec(parse(tc.function.arguments))) copies.push({ i, j })
        if (tc.function.name === 'writeScript') {
          const fileName = parse(tc.function.arguments)?.fileName
          if (fileName) (scripts[fileName] ??= []).push({ i, j })
        }
      })
    if (m.role === 'tool' && SPEC_IN_RESULT.has(toolName[m.tool_call_id]) && parse(m.content)?.spec) copies.push({ i })
  })
  const olderScripts = Object.values(scripts).flatMap((list) => list.slice(0, -1))
  if (copies.length < 2 && !olderScripts.length) return turn
  const out = turn.slice()
  const replaceArgs = (i, j, args) => {
    const calls = out[i].tool_calls.slice()
    calls[j] = { ...calls[j], function: { ...calls[j].function, arguments: JSON.stringify(args) } }
    out[i] = { ...out[i], tool_calls: calls }
  }
  for (const { i, j } of olderScripts) replaceArgs(i, j, { fileName: parse(out[i].tool_calls[j].function.arguments).fileName, code: SCRIPT_OMITTED })
  for (const { i, j } of copies.length < 2 ? [] : copies.slice(0, -1)) {
    if (j == null) {
      out[i] = { ...out[i], content: JSON.stringify({ ...parse(out[i].content), spec: OMITTED }) }
      continue
    }
    const { useValidatedSpec, useDraftSpec } = parse(out[i].tool_calls[j].function.arguments)
    replaceArgs(i, j, { spec: OMITTED, ...(useValidatedSpec && { useValidatedSpec }), ...(useDraftSpec && { useDraftSpec }) })
  }
  return out
}

module.exports = { pastTurns, compactTurn, omitSpecBlocks, OMITTED, SCRIPT_OMITTED }
