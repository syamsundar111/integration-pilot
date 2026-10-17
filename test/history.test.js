/**
 * What the model gets back of a conversation (srv/agent/history.js).
 */
const { pastTurns, compactTurn, omitSpecBlocks, OMITTED } = require('../srv/agent/history')

const spec = (n) => ({ id: 'X', trigger: { type: 'timer', mode: 'once' }, steps: Array.from({ length: n }, () => ({ type: 'jsonToXml' })), end: { type: 'none' } })
const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(content) })

describe('history', () => {
  test('earlier turns keep user messages and final answers only', () => {
    const messages = [
      { role: 'user', content: 'build it' },
      call('a', 'listPackages', {}),
      result('a', [{ id: 'P' }]),
      { role: 'assistant', content: 'Ready.' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'You are welcome.' }
    ]
    expect(pastTurns(messages)).toEqual([messages[0], messages[3], messages[4], messages[5]])
  })

  test('spec JSON in earlier answers is replaced by a note', () => {
    const json = JSON.stringify(spec(30), null, 2)
    expect(omitSpecBlocks(`Here it is:\n\`\`\`json\n${json}\n\`\`\`\nDone.`)).toBe('Here it is:\n```\n(spec JSON omitted; the proposal panel shows it)\n```\nDone.')
    const small = 'Use:\n```json\n{"a": 1}\n```'
    expect(omitSpecBlocks(small)).toBe(small)
  })

  test('within a turn only the newest spec copy is kept', () => {
    const turn = [
      { role: 'user', content: 'change it' },
      call('g', 'getIflowSpec', { iflowId: 'X' }),
      result('g', { editable: true, spec: spec(1), attachedFiles: ['a.groovy'] }),
      call('v1', 'validateSpec', { spec: spec(2) }),
      result('v1', { valid: false, errors: ['E'] }),
      call('v2', 'validateSpec', { spec: spec(3) }),
      result('v2', { valid: true }),
      call('p', 'proposeIflowUpdate', { useValidatedSpec: true }),
      result('p', { valid: true })
    ]
    const before = JSON.stringify(turn)
    const out = compactTurn(turn)
    expect(JSON.stringify(turn)).toBe(before) // the turn itself is stored unchanged
    expect(JSON.parse(out[2].content)).toEqual({ editable: true, spec: OMITTED, attachedFiles: ['a.groovy'] })
    expect(JSON.parse(out[3].tool_calls[0].function.arguments)).toEqual({ spec: OMITTED })
    expect(JSON.parse(out[5].tool_calls[0].function.arguments)).toEqual({ spec: spec(3) })
    expect(out[7]).toBe(turn[7])
    expect(out.map((m) => m.role)).toEqual(turn.map((m) => m.role))
  })

  test('a turn with one spec copy is sent as it is', () => {
    const turn = [{ role: 'user', content: 'x' }, call('v', 'validateSpec', { spec: spec(1) }), result('v', { valid: true })]
    expect(compactTurn(turn)).toBe(turn)
  })
})
