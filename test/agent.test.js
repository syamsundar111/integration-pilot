/**
 * Agent loop, tools, proposal storage and approve/reject execution — end to end through
 * the REST API, with the LLM scripted and the CPI client stubbed (no network).
 */
process.env.LLM_MODEL = 'test/model'
process.env.LLM_RETRY_BASE_MS = '1'
process.env.DEPLOY_POLL_INTERVAL_MS = '10'
process.env.DEPLOY_POLL_TIMEOUT_MS = '300'

jest.mock('../srv/lib/llm', () => ({ chat: jest.fn(), health: jest.fn() }))
jest.mock('../srv/lib/cpi-client', () => {
  const notFound = () => Object.assign(new Error('not found'), { status: 404, code: 'CPI_NOT_FOUND' })
  return {
    MESSAGE_STATUSES: ['FAILED'],
    listPackages: jest.fn(async () => [{ id: 'PilotReference', name: 'Pilot Reference', shortText: 'x' }]),
    getPackage: jest.fn(async (id) => {
      if (id === 'PilotReference') return { id }
      throw notFound()
    }),
    getIflow: jest.fn(async () => {
      throw notFound()
    }),
    createPackage: jest.fn(async (p) => p),
    createIflow: jest.fn(async (f) => ({ ...f, version: '1.0.0' })),
    updateIflowContent: jest.fn(async (id) => ({ id })),
    updateConfiguration: jest.fn(async () => {}),
    deployIflow: jest.fn(async () => ({ taskId: 't1' })),
    getDeployStatus: jest.fn(async () => 'SUCCESS'),
    getRuntimeArtifact: jest.fn(async (id) => ({ id, status: 'STARTED' })),
    getRuntimeError: jest.fn(async () => null),
    downloadIflowZip: jest.fn(),
    getConfigurations: jest.fn(async () => [])
  }
})

const cds = require('@sap/cds')
const llm = require('../srv/lib/llm')
const cpi = require('../srv/lib/cpi-client')
const sample = require('../srv/iflow-builder/samples/Pilot_Test_1.json')

const { GET, POST } = cds.test(__dirname + '/..', '--in-memory')

const toolCall = (name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `${name}:0`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const answer = (content) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] })

/** POST /api/chat, then poll GET /api/chat/turns/{id} until the turn finishes */
async function chat(body) {
  const { data: started } = await POST('/api/chat', body)
  expect(started).toMatchObject({ turnId: expect.any(String), sessionId: expect.any(String), status: 'RUNNING' })
  for (let i = 0; i < 200; i++) {
    const { data } = await GET(`/api/chat/turns/${started.turnId}`)
    if (data.status !== 'RUNNING') return { ...data, sessionId: started.sessionId, turnId: started.turnId }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('turn did not finish')
}

async function waitFor(id, statuses = ['DONE', 'FAILED']) {
  for (let i = 0; i < 100; i++) {
    const { data } = await GET(`/api/Proposals/${id}`)
    if (statuses.includes(data.status)) return data
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('proposal did not finish')
}

beforeEach(() => {
  jest.clearAllMocks()
  // reset per-test overrides of the runtime stubs
  cpi.getRuntimeArtifact.mockImplementation(async (id) => ({ id, status: 'STARTED' }))
  cpi.getRuntimeError.mockResolvedValue(null)
  cpi.getDeployStatus.mockResolvedValue('SUCCESS')
})

describe('agent', () => {
  let sessionId, proposalId

  test('a conversation ends in a stored PENDING proposal', async () => {
    const spec = { ...sample, id: 'Agent_Test_1', name: 'Agent Test 1' }
    llm.chat
      .mockResolvedValueOnce(toolCall('getSupportedSteps', {}))
      .mockResolvedValueOnce(toolCall('proposeIflow', { spec }))
      .mockResolvedValueOnce(answer('The proposal is ready for review.'))

    const data = await chat({ message: 'Build me an HTTPS to HTTP flow' })
    expect(data.text).toBe('The proposal is ready for review.')
    expect(data.proposals).toEqual([expect.objectContaining({ kind: 'IFLOW', status: 'PENDING', iflowId: 'Agent_Test_1', packageId: 'PilotReference', spec })])
    sessionId = data.sessionId
    proposalId = data.proposals[0].ID

    // tool results were fed back with matching tool_call ids
    const lastCall = llm.chat.mock.calls[2][0]
    expect(lastCall.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool'])
    expect(lastCall.messages[5]).toMatchObject({ tool_call_id: 'proposeIflow:0', content: expect.stringContaining('"valid":true') })
    // the hard limits come first, and the model is told not to print specs or ask for given defaults
    expect(lastCall.messages[0].content).toMatch(/^## Hard limits\n/)
    expect(lastCall.messages[0].content).toContain('Never print the spec JSON in chat')
    expect(lastCall.messages[0].content).toContain('never ask about them')
    expect(lastCall.tools.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['listPackages', 'listIflows', 'getIflowDetails', 'getRuntimeStatus', 'getMessageLogs', 'getSupportedSteps', 'validateSpec', 'explainIflow', 'proposeIflow', 'proposePackage'])
    )
  })

  test('messages are persisted in order', async () => {
    const { data } = await GET(`/api/ChatSessions/${sessionId}/messages?$orderby=seq`)
    expect(data.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
  })

  test('invalid specs are returned to the model with errors, not stored', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, steps: [{ type: 'router' }] } })).mockResolvedValueOnce(answer('fixed later'))
    const data = await chat({ sessionId, message: 'add a router' })
    expect(data.proposals).toEqual([])
    const toolMsg = llm.chat.mock.calls[1][0].messages.at(-1)
    expect(JSON.parse(toolMsg.content)).toMatchObject({ valid: false, errors: [expect.stringContaining("'router' is not supported in v1")] })
  })

  test('history is sent back on the next turn (no orphaned tool messages)', async () => {
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId, message: 'thanks' })
    const msgs = llm.chat.mock.calls[0][0].messages
    expect(msgs[0].role).toBe('system')
    expect(msgs[1]).toMatchObject({ role: 'user', content: 'Build me an HTTPS to HTTP flow' })
    expect(msgs.at(-1)).toMatchObject({ role: 'user', content: 'thanks' })
    expect(msgs[0].content).toContain(`${proposalId}: IFLOW Agent_Test_1 → PENDING`)
  })

  test('stops after 8 model calls', async () => {
    llm.chat.mockResolvedValue(toolCall('listPackages', {}))
    const data = await chat({ sessionId, message: 'loop forever' })
    expect(llm.chat).toHaveBeenCalledTimes(8)
    expect(data.text).toMatch(/stopped after 8 steps/)
    llm.chat.mockReset()
  })

  test('LLM rate limit: the turn fails with a clear error, the conversation keeps a note', async () => {
    llm.chat.mockRejectedValueOnce(Object.assign(new Error('The AI model is rate-limited right now'), { status: 429, code: 'LLM_RATE_LIMITED', hint: 'Wait' }))
    const turn = await chat({ sessionId, message: 'hello?' })
    expect(turn).toMatchObject({ status: 'FAILED', error: { code: 'LLM_RATE_LIMITED', message: 'The AI model is rate-limited right now', hint: 'Wait' } })
    expect(turn.events.at(-1)).toMatchObject({ type: 'error', label: 'The AI model is rate-limited right now' })
    const { data } = await GET(`/api/ChatSessions/${sessionId}/messages?$orderby=seq`)
    expect(data.slice(-2).map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello?'],
      ['assistant', '⚠️ The AI model is rate-limited right now']
    ])
  })
})

describe('model failure after a proposal', () => {
  test('the turn ends DONE with a note, keeps the proposal and a consistent history', async () => {
    const spec = { ...sample, id: 'Agent_Timeout_1', name: 'Agent Timeout 1' }
    llm.chat
      .mockResolvedValueOnce(toolCall('proposeIflow', { spec }))
      .mockRejectedValueOnce(Object.assign(new Error('The AI model did not answer within 120s.'), { status: 504, code: 'LLM_TIMEOUT' }))
    const turn = await chat({ message: 'Build it' })
    expect(turn.status).toBe('DONE')
    expect(turn.text).toMatch(/proposal \(iFlow Agent_Timeout_1\) is ready for review.*did not answer within 120s/)
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_Timeout_1', status: 'PENDING' })])
    const { data } = await GET(`/api/ChatSessions/${turn.sessionId}/messages?$orderby=seq`)
    expect(data.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  test('without a proposal, a model failure still fails the turn', async () => {
    llm.chat.mockRejectedValueOnce(Object.assign(new Error('The AI model did not answer within 120s.'), { status: 504, code: 'LLM_TIMEOUT' }))
    const turn = await chat({ message: 'Hello' })
    expect(turn).toMatchObject({ status: 'FAILED', error: { code: 'LLM_TIMEOUT' } })
  })
})

describe('delete conversation', () => {
  test('removes messages, turns and pending proposals; keeps executed proposals detached', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Del_Pending', name: 'Del Pending' } }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Del_Done', name: 'Del Done' } }))
      .mockResolvedValueOnce(answer('two proposals'))
    const turn = await chat({ message: 'two flows' })
    const [pending, done] = turn.proposals
    await POST(`/api/Proposals/${done.ID}/approve`, { deploy: false })
    await waitFor(done.ID)

    await POST(`/api/ChatSessions/${turn.sessionId}/remove`, {})

    await expect(GET(`/api/ChatSessions/${turn.sessionId}`)).rejects.toMatchObject({ response: { status: 404 } })
    const { data: msgs } = await GET(`/api/ChatMessages?$filter=session_ID eq ${turn.sessionId}`)
    expect(msgs).toEqual([])
    await expect(GET(`/api/Proposals/${pending.ID}`)).rejects.toMatchObject({ response: { status: 404 } })
    const { data: kept } = await GET(`/api/Proposals/${done.ID}`)
    expect(kept).toMatchObject({ status: 'DONE', session_ID: null })
    const { data: audit } = await GET(`/api/AuditLog?$filter=action eq 'DELETE_CHAT_SESSION'`)
    expect(audit).toEqual([expect.objectContaining({ targetId: turn.sessionId, status: 'SUCCESS' })])
  })

  test('is refused while the assistant is working (409) and for unknown sessions (404)', async () => {
    let release
    llm.chat.mockImplementationOnce(() => new Promise((r) => (release = () => r(answer('done')))))
    const { data: started } = await POST('/api/chat', { message: 'slow' })
    await expect(POST(`/api/ChatSessions/${started.sessionId}/remove`, {})).rejects.toMatchObject({ response: { status: 409 } })
    release()
    await expect(POST(`/api/ChatSessions/${cds.utils.uuid()}/remove`, {})).rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('async turns', () => {
  const deferred = () => {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    return { promise, resolve }
  }

  test('POST returns at once; progress events show thinking, tools, validation and the proposal', async () => {
    const spec = { ...sample, id: 'Turn_Test_1' }
    const gate = deferred()
    llm.chat
      .mockResolvedValueOnce(toolCall('listPackages', {}))
      .mockImplementationOnce(() => gate.promise.then(() => toolCall('proposeIflow', { spec: { ...spec, steps: [{ type: 'router' }] } })))
      .mockResolvedValueOnce(toolCall('proposeIflow', { spec }))
      .mockResolvedValueOnce(answer('ready'))

    const { data: started } = await POST('/api/chat', { message: 'go' })
    // still running while the model "thinks"
    await new Promise((r) => setTimeout(r, 30))
    const { data: mid } = await GET(`/api/chat/turns/${started.turnId}`)
    expect(mid.status).toBe('RUNNING')
    expect(mid.events.map((e) => e.label)).toEqual(['Thinking…', 'Calling listPackages', 'Thinking…'])

    gate.resolve()
    let done
    for (let i = 0; i < 200 && (!done || done.status === 'RUNNING'); i++) {
      await new Promise((r) => setTimeout(r, 10))
      done = (await GET(`/api/chat/turns/${started.turnId}`)).data
    }
    expect(done).toMatchObject({ status: 'DONE', text: 'ready', proposals: [expect.objectContaining({ iflowId: 'Turn_Test_1', status: 'PENDING' })] })
    expect(done.events.map((e) => e.label)).toEqual([
      'Thinking…',
      'Calling listPackages',
      'Thinking…',
      'Validating spec',
      'Spec has errors — revising',
      'Thinking…',
      'Validating spec',
      'Proposal ready',
      'Thinking…',
      'Answer ready'
    ])
    expect(done.events.every((e) => typeof e.at === 'string')).toBe(true)
  })

  test('only one running turn per session (409)', async () => {
    const gate = deferred()
    llm.chat.mockImplementationOnce(() => gate.promise.then(() => answer('first')))
    const first = await POST('/api/chat', { message: 'one' })
    await expect(POST('/api/chat', { sessionId: first.data.sessionId, message: 'two' })).rejects.toMatchObject({ response: { status: 409, data: { error: { code: 'TURN_IN_PROGRESS' } } } })
    gate.resolve()
  })

  test('cancel aborts the model call and ends the turn as CANCELLED', async () => {
    let seenSignal
    llm.chat.mockImplementationOnce(({ signal }) => {
      seenSignal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }))))
    })
    const { data: started } = await POST('/api/chat', { message: 'slow one' })
    await new Promise((r) => setTimeout(r, 20))
    const { data: cancelled } = await POST(`/api/chat/turns/${started.turnId}/cancel`, {})
    expect(cancelled.cancelRequested).toBe(true)
    expect(seenSignal.aborted).toBe(true)

    let turn
    for (let i = 0; i < 100 && (!turn || turn.status === 'RUNNING'); i++) {
      await new Promise((r) => setTimeout(r, 10))
      turn = (await GET(`/api/chat/turns/${started.turnId}`)).data
    }
    expect(turn).toMatchObject({ status: 'CANCELLED', error: null })
    expect(turn.events.at(-1).label).toBe('Cancelled')
    const { data: msgs } = await GET(`/api/ChatSessions/${started.sessionId}/messages?$orderby=seq`)
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'slow one'],
      ['assistant', 'Cancelled.']
    ])
    await expect(POST(`/api/chat/turns/${started.turnId}/cancel`, {})).rejects.toMatchObject({ response: { status: 409 } })
  })

  test('turns still RUNNING at startup are marked FAILED and the message is kept', async () => {
    const { recoverInterruptedTurns, INTERRUPTED } = require('../srv/agent/agent')
    const sessionId = cds.utils.uuid()
    const turnId = cds.utils.uuid()
    await INSERT.into('iflowpilot.ChatSession').entries({ ID: sessionId, title: 'x' })
    await INSERT.into('iflowpilot.ChatTurn').entries({ ID: turnId, session_ID: sessionId, status: 'RUNNING', message: 'lost?', events: '[]' })
    expect(await recoverInterruptedTurns()).toBe(1)
    const { data } = await GET(`/api/chat/turns/${turnId}`)
    expect(data).toMatchObject({ status: 'FAILED', error: { code: 'INTERRUPTED', message: INTERRUPTED } })
    const { data: msgs } = await GET(`/api/ChatSessions/${sessionId}/messages?$orderby=seq`)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('proposal execution', () => {
  let proposalId

  beforeAll(async () => {
    const spec = { ...sample, id: 'Exec_Test_1', name: 'Exec Test 1', packageId: 'NewPkg' }
    llm.chat
      .mockResolvedValueOnce(toolCall('proposePackage', { id: 'NewPkg', name: 'New Package' }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { spec }))
      .mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'new package and flow' })
    expect(data.proposals.map((p) => p.kind)).toEqual(['PACKAGE', 'IFLOW'])
    proposalId = data.proposals[1].ID
  })

  test('approve + deploy runs all steps and ends DONE', async () => {
    const { data } = await POST(`/api/Proposals/${proposalId}/approve`, { deploy: true })
    expect(data.status).toBe('APPROVED')
    const done = await waitFor(proposalId)
    expect(done).toMatchObject({ status: 'DONE', error: null, result: { deploy: true, runtimeStatus: 'STARTED' } })
    expect(done.result.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['package:done', 'build:done', 'create:done', 'configure:done', 'deploy:done', 'runtime:done'])
    expect(cpi.createPackage).toHaveBeenCalledWith({ id: 'NewPkg', name: 'New Package', shortText: 'New Package' })
    expect(cpi.createIflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'Exec_Test_1', packageId: 'NewPkg', zipBase64: expect.any(String) }))
    expect(cpi.updateConfiguration).toHaveBeenCalledWith('Exec_Test_1', 'ReceiverURL', 'https://httpbin.org/post')

    const { data: audit } = await GET('/api/AuditLog?$orderby=createdAt')
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['APPROVE_PROPOSAL', 'CREATE_PACKAGE', 'CREATE_IFLOW', 'UPDATE_CONFIGURATION', 'DEPLOY_IFLOW']))
  })

  test('only PENDING proposals can be approved or rejected', async () => {
    await expect(POST(`/api/Proposals/${proposalId}/approve`, {})).rejects.toMatchObject({ response: { status: 409 } })
    await expect(POST(`/api/Proposals/${proposalId}/reject`, {})).rejects.toMatchObject({ response: { status: 409 } })
  })

  test('deployment errors end FAILED with the CPI error text', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_Test_2' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'another' })
    cpi.getRuntimeArtifact.mockResolvedValue({ status: 'ERROR' })
    cpi.getRuntimeError.mockResolvedValue({ message: 'Receiver URL invalid' })
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: true })
    const failed = await waitFor(data.proposals[0].ID)
    expect(failed).toMatchObject({ status: 'FAILED', error: 'Deployment failed: Receiver URL invalid' })
    expect(failed.result.steps.find((s) => s.key === 'runtime')).toMatchObject({ status: 'failed' })
  })

  test('slow deployment (task SUCCESS, runtime not visible yet) ends DONE with a warning, not FAILED', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_Slow' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'slow deploy' })
    cpi.getRuntimeArtifact.mockResolvedValue(null)
    cpi.getDeployStatus.mockResolvedValue('SUCCESS')
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: true })
    const done = await waitFor(data.proposals[0].ID)
    expect(done).toMatchObject({ status: 'DONE', result: { runtimeStatus: 'NOT_DEPLOYED', warning: expect.stringContaining('not running yet') } })
    expect(done.result.steps.find((s) => s.key === 'runtime')).toMatchObject({ status: 'warning' })
  })

  test('deploy task FAIL ends FAILED', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_TaskFail' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'task fails' })
    cpi.getRuntimeArtifact.mockResolvedValue(null)
    cpi.getDeployStatus.mockResolvedValue('FAIL')
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: true })
    const failed = await waitFor(data.proposals[0].ID)
    expect(failed).toMatchObject({ status: 'FAILED', error: expect.stringContaining('build/deploy task as FAIL') })
  })

  test('reject stores the reason and the agent sees it next turn', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_Test_3' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'third' })
    const id = data.proposals[0].ID
    const { data: rejected } = await POST(`/api/Proposals/${id}/reject`, { reason: 'wrong receiver' })
    expect(rejected).toMatchObject({ status: 'REJECTED', result: { reason: 'wrong receiver' } })

    llm.chat.mockResolvedValueOnce(answer('understood'))
    await chat({ sessionId: data.sessionId, message: 'why?' })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).toContain(`${id}: IFLOW Exec_Test_3 → REJECTED (rejected by the user) — reason: wrong receiver`)
  })
})

describe('restart recovery and retry', () => {
  const { recoverInterrupted, INTERRUPTED } = require('../srv/lib/proposals')

  async function proposal(id) {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: `propose ${id}` })
    return data.proposals[0].ID
  }

  /** Simulates a crash mid-execution: APPROVED with a running step */
  const interrupt = (ID) =>
    UPDATE('iflowpilot.Proposal', ID).set({
      status: 'APPROVED',
      result: JSON.stringify({ deploy: true, attempt: 1, steps: [{ key: 'package', status: 'done' }, { key: 'build', status: 'running' }, { key: 'create', status: 'pending' }] })
    })

  test('APPROVED proposals are marked FAILED at startup', async () => {
    const id = await proposal('Recover_1')
    await interrupt(id)
    expect(await recoverInterrupted()).toBe(1)
    const { data } = await GET(`/api/Proposals/${id}`)
    expect(data).toMatchObject({ status: 'FAILED', error: INTERRUPTED })
    expect(data.result.steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped'])
  })

  test('retry re-runs a FAILED proposal and updates an iFlow left by the earlier attempt', async () => {
    const id = await proposal('Recover_2')
    await interrupt(id)
    await recoverInterrupted()
    // the interrupted attempt had already created the iFlow in the target package
    cpi.getIflow.mockResolvedValueOnce({ id: 'Recover_2', packageId: 'PilotReference' })
    cpi.getRuntimeArtifact.mockResolvedValue({ status: 'STARTED' })

    const { data } = await POST(`/api/Proposals/${id}/retry`, {})
    expect(data).toMatchObject({ status: 'APPROVED', result: { attempt: 2, deploy: true, previousError: INTERRUPTED } })
    const done = await waitFor(id)
    expect(done.status).toBe('DONE')
    expect(done.result.steps.find((s) => s.key === 'create').detail).toBe('Updated existing Recover_2 in PilotReference')
    expect(cpi.updateIflowContent).toHaveBeenCalledWith('Recover_2', expect.objectContaining({ zipBase64: expect.any(String) }))
    expect(cpi.createIflow).not.toHaveBeenCalled()
    const { data: audit } = await GET('/api/AuditLog?$orderby=createdAt')
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['RETRY_PROPOSAL', 'UPDATE_IFLOW']))
  })

  test('never overwrites an iFlow with the same id in another package', async () => {
    const id = await proposal('Recover_3')
    await interrupt(id)
    await recoverInterrupted()
    cpi.getIflow.mockResolvedValueOnce({ id: 'Recover_3', packageId: 'SomeoneElses' })
    await POST(`/api/Proposals/${id}/retry`, { deploy: false })
    const failed = await waitFor(id)
    expect(failed).toMatchObject({ status: 'FAILED', error: expect.stringContaining("already exists in package 'SomeoneElses'") })
    expect(cpi.updateIflowContent).not.toHaveBeenCalled()
  })

  test('only FAILED proposals can be retried', async () => {
    const id = await proposal('Recover_4')
    await expect(POST(`/api/Proposals/${id}/retry`, {})).rejects.toMatchObject({ response: { status: 409, data: { error: { code: 'PROPOSAL_NOT_FAILED' } } } })
  })
})

describe('target package', () => {
  async function propose(id, packageId) {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id, packageId } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: `propose ${id}` })
    return { data, toolResult: JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content) }
  }

  test('a missing package is reported to the agent with similar existing packages', async () => {
    const { toolResult } = await propose('Pkg_Test_1', 'PilotRefrence') // typo
    expect(toolResult).toMatchObject({ valid: true, packageNote: expect.stringContaining("'PilotRefrence' does not exist"), similarPackages: [{ id: 'PilotReference', name: 'Pilot Reference' }] })
  })

  test('setPackage: switch to an existing package', async () => {
    const { data } = await propose('Pkg_Test_2', 'Nope')
    const { data: p } = await POST(`/api/Proposals/${data.proposals[0].ID}/setPackage`, { packageId: 'PilotReference' })
    expect(p).toMatchObject({ packageId: 'PilotReference', packageName: null, spec: { packageId: 'PilotReference' } })
  })

  test('setPackage: a missing package needs a name; invalid ids are rejected', async () => {
    const { data } = await propose('Pkg_Test_3', 'Nope')
    const id = data.proposals[0].ID
    await expect(POST(`/api/Proposals/${id}/setPackage`, { packageId: 'Missing' })).rejects.toMatchObject({ response: { status: 400, data: { error: { code: 'PACKAGE_NOT_FOUND' } } } })
    await expect(POST(`/api/Proposals/${id}/setPackage`, { packageId: 'Bad_Id', packageName: 'x' })).rejects.toMatchObject({ response: { status: 400, data: { error: { code: 'INVALID_PACKAGE_ID' } } } })
  })

  test('a new package is created on approval with the chosen name', async () => {
    const { data } = await propose('Pkg_Test_4', 'Nope')
    const id = data.proposals[0].ID
    await POST(`/api/Proposals/${id}/setPackage`, { packageId: 'Orders.Inbound', packageName: 'Orders Inbound' })
    await POST(`/api/Proposals/${id}/approve`, { deploy: false })
    const done = await waitFor(id)
    expect(done.status).toBe('DONE')
    expect(cpi.createPackage).toHaveBeenCalledWith({ id: 'Orders.Inbound', name: 'Orders Inbound', shortText: 'Orders Inbound' })
    expect(cpi.createIflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'Pkg_Test_4', packageId: 'Orders.Inbound' }))
    await expect(POST(`/api/Proposals/${id}/setPackage`, { packageId: 'PilotReference' })).rejects.toMatchObject({ response: { status: 409 } })
  })
})

describe('authorization', () => {
  test('the API requires the Admin role (role collection IntegrationPilot_Admin)', async () => {
    const srv = await cds.connect.to('ApiService')
    const call = (user) => srv.tx({ user }, (tx) => tx.send('me'))
    await expect(call(new cds.User({ id: 'viewer', roles: [] }))).rejects.toMatchObject({ code: 403 })
    await expect(call(new cds.User({ id: 'admin', roles: ['Admin'] }))).resolves.toEqual({ id: 'admin' })
  })

  test('local development runs as local-dev with the Admin role', async () => {
    const { data } = await GET('/api/me')
    expect(data).toEqual({ id: 'local-dev' })
  })
})

describe('llm-health', () => {
  test('GET /api/llm-health is an alias of llmHealth', async () => {
    llm.health.mockResolvedValue({ ok: true, model: 'test/model', latencyMs: 5, reply: 'OK', error: null })
    const { data } = await GET('/api/llm-health')
    expect(data).toMatchObject({ ok: true, latencyMs: 5 })
  })
})

describe('update an existing iFlow (exception subprocess)', () => {
  const { build } = require('../srv/iflow-builder/builder')
  const ERROR_BODY = '{"status": "Failed", "error": "${exception.message}"}'
  // The iFlow on the tenant: JSON to XML, no error handling
  const current = {
    id: 'Order_JSON_to_XML',
    name: 'Order JSON to XML',
    packageId: 'PilotReference',
    trigger: { type: 'httpsSender', address: '/orders/json-to-xml' },
    steps: [{ type: 'jsonToXml' }],
    end: { type: 'none' }
  }
  const notFound = () => Object.assign(new Error('not found'), { status: 404 })
  let editable

  beforeAll(async () => {
    const zip = Buffer.from((await build(current)).zipBase64, 'base64')
    cpi.getIflow.mockImplementation(async (id) => {
      if (id === current.id) return { id, name: current.name, packageId: 'PilotReference' }
      throw notFound()
    })
    cpi.downloadIflowZip.mockImplementation(async () => zip)
  })
  afterAll(() =>
    cpi.getIflow.mockImplementation(async () => {
      throw notFound()
    })
  )

  test('getIflowSpec returns the current iFlow as a spec', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id })).mockResolvedValueOnce(answer('read'))
    await chat({ message: 'show it' })
    const result = JSON.parse(llm.chat.mock.calls[1][0].messages.at(-1).content)
    expect(result).toMatchObject({ editable: true, spec: { id: current.id, packageId: 'PilotReference', steps: [{ type: 'jsonToXml', name: 'JSON to XML Converter 1' }], end: { type: 'none' } } })
    editable = result.spec
  })

  test('"Add an Exception Subprocess with Set Error Body" ends in an UPDATE proposal that updates the iFlow on approval', async () => {
    const spec = {
      ...editable,
      exceptionSubprocess: {
        steps: [{ type: 'contentModifier', name: 'Set Error Body', headers: [{ name: 'CamelHttpResponseCode', type: 'constant', value: '500' }], body: ERROR_BODY }]
      }
    }
    llm.chat
      .mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id }))
      .mockResolvedValueOnce(toolCall('proposeIflowUpdate', { spec }))
      .mockResolvedValueOnce(answer('The update is ready for review.'))
    const turn = await chat({ message: 'Update the iFlow "Order JSON to XML" in package PilotReference: add an Exception Subprocess with a Content Modifier "Set Error Body"' })

    const result = JSON.parse(llm.chat.mock.calls[2][0].messages.at(-1).content)
    expect(result).toMatchObject({ valid: true, operation: 'UPDATE', changes: ['exception subprocess added: Set Error Body'], summary: { exceptionSubprocess: { name: 'Exception Subprocess 1' } } })
    expect(turn.events.map((e) => e.label)).toContain('Update proposal ready')
    const [proposal] = turn.proposals
    expect(proposal).toMatchObject({ kind: 'IFLOW', operation: 'UPDATE', iflowId: current.id, status: 'PENDING' })

    await expect(POST(`/api/Proposals/${proposal.ID}/setPackage`, { packageId: 'PilotReference' })).rejects.toMatchObject({ response: { status: 400, data: { error: { code: 'UPDATE_KEEPS_PACKAGE' } } } })

    await POST(`/api/Proposals/${proposal.ID}/approve`, { deploy: false })
    const done = await waitFor(proposal.ID)
    expect(done.status).toBe('DONE')
    expect(done.result.steps.find((s) => s.key === 'create')).toMatchObject({ label: 'Update iFlow', detail: `Updated existing ${current.id} in PilotReference` })
    expect(cpi.createIflow).not.toHaveBeenCalled()
    const [, { zipBase64 }] = cpi.updateIflowContent.mock.calls.at(-1)
    const { parse } = require('../srv/iflow-builder/parser')
    expect((await parse(zipBase64)).exceptionSubprocess).toMatchObject({ steps: [{ name: 'Set Error Body', body: ERROR_BODY }] })
  })

  test('proposeIflow with an existing id points the model to the update tools', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: editable })).mockResolvedValueOnce(answer('x'))
    await chat({ message: 'create it again' })
    const result = JSON.parse(llm.chat.mock.calls[1][0].messages.at(-1).content)
    expect(result.errors[0]).toMatch(/already exists .* getIflowSpec and then proposeIflowUpdate/)
  })

  test('updates are refused for missing iFlows, another package, or no change', async () => {
    const errorsFor = async (spec) => {
      llm.chat.mockResolvedValueOnce(toolCall('proposeIflowUpdate', { spec })).mockResolvedValueOnce(answer('x'))
      await chat({ message: 'update' })
      return JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content).errors.join('\n')
    }
    expect(await errorsFor({ ...editable, id: 'Does_Not_Exist' })).toMatch(/does not exist — use proposeIflow/)
    expect(await errorsFor({ ...editable, packageId: 'Other' })).toMatch(/an update keeps the package/)
    expect(await errorsFor(editable)).toMatch(/nothing changed/)
  })
})

describe('spec arguments in the wrong shape', () => {
  test('proposeIflow accepts an unwrapped spec with nested objects as JSON strings', async () => {
    const spec = { ...sample, id: 'Agent_Shape_1', name: 'Agent Shape 1' }
    const flat = { ...spec, trigger: JSON.stringify(spec.trigger), steps: JSON.stringify(spec.steps), end: JSON.stringify(spec.end) }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', flat)).mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ message: 'Build it' })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_Shape_1', status: 'PENDING', spec })])

    // the next turn tells the model what the status means
    llm.chat.mockResolvedValueOnce(answer('Still waiting.'))
    await chat({ sessionId: turn.sessionId, message: 'status?' })
    expect(llm.chat.mock.calls[2][0].messages[0].content).toMatch(/Agent_Shape_1 → PENDING \(waiting for the user to approve or reject\)/)
  })
})

describe('session defaults', () => {
  test('are stored on the session and sent to the model as structured context', async () => {
    const defaults = { packageId: 'DEV.SF.Directory', timer: 'once', authNote: 'OAuth2 SAML Bearer, credential DEMO_OAUTH' }
    llm.chat.mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ message: 'Create the iFlow', defaults })
    const system = llm.chat.mock.calls.at(-1)[0].messages[0].content
    expect(system).toContain('{"packageId":"DEV.SF.Directory","trigger":{"type":"timer","mode":"once"},"receiverAuthentication":"OAuth2 SAML Bearer, credential DEMO_OAUTH"}')
    expect(system).toMatch(/never ask about them/)
    const { data: session } = await GET(`/api/ChatSessions/${turn.sessionId}`)
    expect(JSON.parse(session.defaults)).toEqual(defaults)

    // omitted: the stored defaults stay; empty: cleared
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: turn.sessionId, message: 'next' })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).toContain('"packageId":"DEV.SF.Directory"')
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: turn.sessionId, message: 'again', defaults: { packageId: '', timer: '', authNote: '' } })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).not.toContain('Session defaults')
  })

  test('invalid defaults are rejected', async () => {
    await expect(POST('/api/chat', { message: 'x', defaults: { packageId: 'DEV_SF' } })).rejects.toMatchObject({ response: { status: 400 } })
    await expect(POST('/api/chat', { message: 'x', defaults: { timer: 'hourly' } })).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe('validate, then propose', () => {
  test('validateSpec returns compact codes; proposeIflow reuses the validated spec', async () => {
    const spec = { ...sample, id: 'Agent_Validated_1', name: 'Agent Validated 1' }
    const broken = { ...spec, steps: [...spec.steps, { type: 'router' }] }
    llm.chat
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true })) // nothing validated yet
      .mockResolvedValueOnce(toolCall('validateSpec', { spec: broken }))
      .mockResolvedValueOnce(toolCall('validateSpec', { spec }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ message: 'Build it' })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_Validated_1', status: 'PENDING', spec })])

    const results = llm.chat.mock.calls[4][0].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
    expect(results[0]).toMatchObject({ valid: false, errors: [expect.stringMatching(/^NO_VALIDATED_SPEC /)] })
    expect(results[1]).toMatchObject({ valid: false, errors: [expect.stringMatching(/^STEP_NOT_IN_V1 steps\[\d+\]: 'router'/)] })
    expect(results[2]).toEqual({ valid: true, next: expect.stringContaining('useValidatedSpec') })
    expect(results[3]).toMatchObject({ valid: true, iflowId: 'Agent_Validated_1' })
    // tool results never echo the spec
    for (const r of results) expect(JSON.stringify(r)).not.toContain('"type":"contentModifier"')
    expect(turn.events.map((e) => e.type)).toContain('validation')
  })
})

describe('attached files', () => {
  const { GROOVY } = require('./helpers')
  const MARKER = 'X-Attached-Marker'
  const script = GROOVY.replace("'X-Test'", `'${MARKER}'`)

  test('the model sees names only; the proposal builds with the attached content', async () => {
    const spec = {
      ...sample,
      id: 'Agent_Attached_1',
      name: 'Agent Attached 1',
      steps: [sample.steps[0], { type: 'groovyScript', name: 'Map Users', fileName: 'mapUsers' }]
    }
    llm.chat
      .mockResolvedValueOnce(toolCall('validateSpec', { spec }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ message: 'Use the attached script', attachments: [{ fileName: 'mapUsers.groovy', content: script }] })
    const [proposal] = turn.proposals
    expect(proposal).toMatchObject({ iflowId: 'Agent_Attached_1', status: 'PENDING' })

    const sent = JSON.stringify(llm.chat.mock.calls.map((c) => c[0].messages))
    expect(sent).toContain('mapUsers.groovy (Groovy,')
    expect(sent).not.toContain(MARKER)

    const { data: files } = await GET(`/api/Attachments?$filter=session_ID eq ${turn.sessionId}`)
    expect(files).toEqual([expect.objectContaining({ fileName: 'mapUsers.groovy', kind: 'groovy', origin: 'upload' })])
    expect(files[0].content).toBeUndefined()

    const { data: stored } = await GET(`/api/Proposals/${proposal.ID}`)
    expect(stored.attachments).toEqual({ 'mapUsers.groovy': script })
    await POST(`/api/Proposals/${proposal.ID}/approve`, { deploy: false })
    expect((await waitFor(proposal.ID)).status).toBe('DONE')
    const { zipBase64 } = cpi.createIflow.mock.calls.at(-1)[0]
    const zip = await require('jszip').loadAsync(Buffer.from(zipBase64, 'base64'))
    expect(await zip.file('src/main/resources/script/mapUsers.groovy').async('string')).toBe(script)
  })

  test('getIflowSpec attaches the scripts of an existing iFlow instead of returning them', async () => {
    const { build } = require('../srv/iflow-builder/builder')
    const existing = { ...sample, id: 'Existing_Groovy', steps: [sample.steps[0], { ...sample.steps[1], code: script }] }
    const zip = Buffer.from((await build(existing)).zipBase64, 'base64')
    cpi.getIflow.mockImplementation(async (id) => {
      if (id === existing.id) return { id, name: existing.name, packageId: 'PilotReference' }
      throw Object.assign(new Error('not found'), { status: 404 })
    })
    cpi.downloadIflowZip.mockImplementation(async () => zip)
    try {
      const changed = (spec) => ({ ...spec, steps: [{ ...spec.steps[0], name: 'Set Headers' }, spec.steps[1]] })
      llm.chat.mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: existing.id })).mockResolvedValueOnce(answer('read'))
      const first = await chat({ message: 'show it' })
      const result = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
      expect(result).toMatchObject({ editable: true, attachedFiles: ['addLengthHeader.groovy'] })
      expect(result.spec.steps[1]).toEqual({ type: 'groovyScript', name: 'Add Length Header', fileName: 'addLengthHeader' })
      expect(JSON.stringify(llm.chat.mock.calls.at(-1)[0].messages)).not.toContain(MARKER)

      llm.chat
        .mockResolvedValueOnce(toolCall('validateSpec', { spec: changed(result.spec) }))
        .mockResolvedValueOnce(toolCall('proposeIflowUpdate', { useValidatedSpec: true }))
        .mockResolvedValueOnce(answer('ok'))
      const turn = await chat({ sessionId: first.sessionId, message: 'rename the first step' })
      const update = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
      // the script is unchanged: only the renamed step counts as a change
      expect(update).toMatchObject({ valid: true, operation: 'UPDATE', changes: [expect.stringMatching(/^steps: Set Pilot Headers → Add Length Header {2}⇒ {2}Set Headers → Add Length Header$/)] })
      const { data: proposal } = await GET(`/api/Proposals/${turn.proposals[0].ID}`)
      expect(proposal.attachments).toEqual({ 'addLengthHeader.groovy': script })
    } finally {
      cpi.getIflow.mockImplementation(async () => {
        throw Object.assign(new Error('not found'), { status: 404 })
      })
    }
  })

  test('invalid attachments are rejected before a session is created', async () => {
    await expect(POST('/api/chat', { message: 'x', attachments: [{ fileName: 'notes.txt', content: 'x' }] })).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe('import an iFlow', () => {
  test('the import becomes the draft spec; it is proposed without the model writing the spec', async () => {
    const fs = require('fs')
    const { build } = require('../srv/iflow-builder/builder')
    const dir = `${__dirname}/fixtures/sf-entra`
    const spec = JSON.parse(fs.readFileSync(`${dir}/spec.json`, 'utf8'))
    const attachments = { 'mapSfToEntra.groovy': fs.readFileSync(`${dir}/mapSfToEntra.groovy`, 'utf8'), 'buildErrorNotification.groovy': fs.readFileSync(`${dir}/buildErrorNotification.groovy`, 'utf8') }
    const { zipBase64 } = await build(spec, { attachments })

    const { data: imported } = await POST('/api/importIflow', { fileName: 'sf-entra.zip', contentBase64: zipBase64, packageId: 'PilotReference' })
    expect(imported).toMatchObject({ valid: true, placeholders: 0, spec: { id: spec.id, packageId: 'PilotReference' } })
    expect(imported.attachments.sort()).toEqual(['buildErrorNotification.groovy', 'mapSfToEntra.groovy'])
    const { data: messages } = await GET(`/api/ChatSessions/${imported.sessionId}/messages?$orderby=seq`)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toMatch(/^Imported \*\*SF SourceApp EC to Target Directory_Employee Data Replication_V1\*\*/)

    llm.chat
      .mockResolvedValueOnce(toolCall('validateSpec', { useDraftSpec: true }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ sessionId: imported.sessionId, message: 'Propose the imported iFlow as a new iFlow.' })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: spec.id, status: 'PENDING' })])
    const sent = llm.chat.mock.calls.at(-1)[0].messages
    expect(sent[0].content).toMatch(/Draft spec of this conversation \(imported from sf-entra.zip\): SF_SourceApp_EC_to_Microsoft_Directory_ID_Employee_Data_Replication_V1/)
    expect(sent[0].content).toContain('mapSfToEntra.groovy (Groovy,')
    expect(JSON.stringify(sent)).not.toContain('ValueMappingApi') // the script body never reaches the model
    const { data: proposal } = await GET(`/api/Proposals/${turn.proposals[0].ID}`)
    expect(proposal.attachments).toEqual(attachments)
  })

  test('only .zip and .iflw files are imported', async () => {
    await expect(POST('/api/importIflow', { fileName: 'x.txt', contentBase64: 'eA==' })).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe('history trimming and the latest spec as session state', () => {
  test('earlier tool exchanges are not re-sent; a spec validated last turn can still be proposed', async () => {
    const spec = { ...sample, id: 'Agent_State_1', name: 'Agent State 1' }
    const broken = { ...spec, steps: [...spec.steps, { type: 'router' }] }
    llm.chat
      .mockResolvedValueOnce(toolCall('getSupportedSteps', {}))
      .mockResolvedValueOnce(toolCall('validateSpec', { spec: broken }))
      .mockResolvedValueOnce(toolCall('validateSpec', { spec }))
      .mockResolvedValueOnce(answer('The spec is valid. Shall I propose it?'))
    const first = await chat({ message: 'Build it' })
    // within the turn: the broken copy was replaced once the fixed one was sent
    const lastOfTurn = llm.chat.mock.calls.at(-1)[0].messages
    expect(lastOfTurn.filter((m) => m.tool_calls).map((m) => m.tool_calls[0].function.name)).toEqual(['getSupportedSteps', 'validateSpec', 'validateSpec'])
    expect(JSON.parse(lastOfTurn.find((m) => m.tool_calls?.[0].function.name === 'validateSpec').tool_calls[0].function.arguments).spec).toMatch(/^\(older spec omitted/)

    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true })).mockResolvedValueOnce(answer('Ready.'))
    const second = await chat({ sessionId: first.sessionId, message: 'Yes, propose it.' })
    expect(second.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_State_1', spec })])

    // the second turn got the first one as user message + answer only, and the spec as context
    const sent = llm.chat.mock.calls.at(-2)[0].messages
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(sent[0].content).toMatch(/Draft spec of this conversation \(your latest validateSpec, valid\): Agent_State_1/)
    expect(JSON.stringify(sent)).not.toContain('"type":"router"')

    // the database keeps the full exchange
    const { data: stored } = await GET(`/api/ChatSessions/${first.sessionId}/messages?$orderby=seq`)
    expect(stored.filter((m) => m.role === 'tool')).toHaveLength(4)
  })
})

describe('a spec sent as a broken JSON string', () => {
  test('gets SPEC_NOT_JSON with the parser position', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('validateSpec', { spec: '{"id": "X", "code": "\\$bad"}' })).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'Build it' })
    const result = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
    expect(result).toMatchObject({ valid: false, errors: [expect.stringMatching(/^SPEC_NOT_JSON spec: sent as a string that is not valid JSON \(.*position/)] })
  })
})
