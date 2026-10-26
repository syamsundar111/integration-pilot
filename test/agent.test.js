/**
 * Agent loop, tools, proposal storage and approve/reject execution — end to end through
 * the REST API, with the LLM scripted and the CPI client stubbed (no network).
 */
process.env.LLM_MODEL = 'test/model'
process.env.LLM_RETRY_BASE_MS = '1'
process.env.DEPLOY_POLL_INTERVAL_MS = '10'
process.env.DEPLOY_POLL_TIMEOUT_MS = '300'
process.env.AGENT_ASK_PACKAGE = 'false' // the package rule has its own tests ('package not given')

jest.mock('../srv/lib/llm', () => ({ chat: jest.fn(), health: jest.fn() }))
jest.mock('../srv/lib/groovy-check', () => {
  const actual = jest.requireActual('../srv/lib/groovy-check')
  const mock = { checkScripts: jest.fn(async () => ({ checked: true, errors: [] })), required: jest.fn(() => false), lint: actual.lint }
  // the real per-file logic on top of the mocked sidecar call
  mock.checkSpecScripts = (spec, attachments) => actual.checkSpecScripts(spec, attachments, { check: (s) => mock.checkScripts(s) })
  return mock
})
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
    saveIflowAsVersion: jest.fn(async () => {}),
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
const groovyCheck = require('../srv/lib/groovy-check')
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

  test('stops after 20 model calls (AGENT_MAX_MODEL_CALLS)', async () => {
    llm.chat.mockResolvedValue(toolCall('listPackages', {}))
    const data = await chat({ sessionId, message: 'loop forever' })
    expect(llm.chat).toHaveBeenCalledTimes(20)
    expect(data.text).toMatch(/stopped after 20 steps/)
    llm.chat.mockClear()
    process.env.AGENT_MAX_MODEL_CALLS = '3'
    try {
      expect((await chat({ sessionId, message: 'loop again' })).text).toMatch(/stopped after 3 steps/)
      expect(llm.chat).toHaveBeenCalledTimes(3)
    } finally {
      delete process.env.AGENT_MAX_MODEL_CALLS
      llm.chat.mockReset()
    }
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

describe('conversation names', () => {
  test('a proposal names the conversation after its iFlow; a rename is kept', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Name_One', name: 'Name One' } })).mockResolvedValueOnce(answer('proposed'))
    const turn = await chat({ message: 'Build a flow that does something' })
    const { data: named } = await GET(`/api/ChatSessions/${turn.sessionId}`)
    expect(named).toMatchObject({ title: `Name One · ${sample.packageId}`, titleEdited: false })

    const { data: renamed } = await POST(`/api/ChatSessions/${turn.sessionId}/rename`, { title: '  My   weather flow ' })
    expect(renamed).toMatchObject({ title: 'My weather flow', titleEdited: true })

    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Name_Two', name: 'Name Two' } })).mockResolvedValueOnce(answer('proposed again'))
    await chat({ message: 'Another one', sessionId: turn.sessionId })
    const { data: kept } = await GET(`/api/ChatSessions/${turn.sessionId}`)
    expect(kept.title).toBe('My weather flow')
  })

  test('rename refuses an empty name (400) and unknown sessions (404)', async () => {
    llm.chat.mockResolvedValueOnce(answer('hi'))
    const turn = await chat({ message: 'Hello' })
    await expect(POST(`/api/ChatSessions/${turn.sessionId}/rename`, { title: '   ' })).rejects.toMatchObject({ response: { status: 400 } })
    await expect(POST(`/api/ChatSessions/${cds.utils.uuid()}/rename`, { title: 'x' })).rejects.toMatchObject({ response: { status: 404 } })
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
    await INSERT.into('iflowpilot.ChatSession').entries({ ID: sessionId, title: 'x', createdBy: 'local-dev' }) // owned by the test user
    await INSERT.into('iflowpilot.ChatTurn').entries({ ID: turnId, session_ID: sessionId, status: 'RUNNING', message: 'lost?', events: '[]' })
    expect(await recoverInterruptedTurns()).toBe(1)
    const { data } = await GET(`/api/chat/turns/${turnId}`)
    expect(data).toMatchObject({ status: 'FAILED', error: { code: 'INTERRUPTED', message: INTERRUPTED } })
    const { data: msgs } = await GET(`/api/ChatSessions/${sessionId}/messages?$orderby=seq`)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('package Name vs ID (manual test 10)', () => {
  const lastToolResult = () => JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
  async function propose(id, packageId, body = {}) {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id, packageId } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: `propose ${id}`, ...body })
    return { data, toolResult: lastToolResult() }
  }

  test('a Name with underscores becomes the ID without them; approving creates the package with the Name', async () => {
    const { data, toolResult } = await propose('PkgName_1', 'test_1')
    expect(toolResult).toMatchObject({ valid: true, packageIdNote: expect.stringMatching(/^Package ID will be test1 \(CPI does not allow underscores in IDs\)\. Tell the user/) })
    expect(toolResult.similarPackages).toBeUndefined() // nothing to ask
    const [p] = data.proposals
    expect(p).toMatchObject({ packageId: 'test1', spec: { packageId: 'test1' } })
    const { data: stored } = await GET(`/api/Proposals/${p.ID}`)
    expect(stored.packageName).toBe('test_1')

    cpi.createPackage.mockClear()
    await POST(`/api/Proposals/${p.ID}/approve`, { deploy: false })
    expect(await waitFor(p.ID)).toMatchObject({ status: 'DONE' })
    expect(cpi.createPackage).toHaveBeenCalledWith({ id: 'test1', name: 'test_1', shortText: 'test_1' })
  })

  test('spaces are removed too and the capitalisation is kept', async () => {
    const { data, toolResult } = await propose('PkgName_2', 'My Test_Package')
    expect(toolResult.packageIdNote).toMatch(/^Package ID will be MyTestPackage \(CPI does not allow underscores or spaces in IDs\)\./)
    expect(data.proposals[0].packageId).toBe('MyTestPackage')
  })

  test('the derived ID of an existing package with the same Name is used as it is', async () => {
    cpi.getPackage.mockImplementationOnce(async (id) => ({ id, name: 'Pilot_Reference' }))
    const { data, toolResult } = await propose('PkgName_3', 'Pilot_Reference')
    expect(toolResult).toMatchObject({ valid: true, packageIdNote: expect.stringContaining('Package ID will be PilotReference') })
    expect(data.proposals[0]).toMatchObject({ packageId: 'PilotReference' })
  })

  test('asks only when the derived ID is empty or belongs to a package with another Name', async () => {
    const { data: empty, toolResult: noId } = await propose('PkgName_4', '___')
    expect(noId).toMatchObject({ valid: false, errors: [expect.stringMatching(/has no letters or digits.*ask the user/)] })
    expect(empty.proposals).toEqual([])

    cpi.getPackage.mockImplementationOnce(async (id) => ({ id, name: 'Something Else' }))
    const { data: clash, toolResult: taken } = await propose('PkgName_5', 'Pilot_Reference')
    expect(taken).toMatchObject({ valid: false, errors: [expect.stringMatching(/becomes the package ID 'PilotReference', but package 'PilotReference' already exists with the name 'Something Else' — ask the user/)] })
    expect(clash.proposals).toEqual([])
  })

  test('proposePackage takes a Name as the id', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposePackage', { id: 'Sales_Orders EU' })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'new package Sales_Orders EU' })
    expect(lastToolResult()).toMatchObject({ valid: true, packageIdNote: expect.stringContaining('Package ID will be SalesOrdersEU') })
    expect(data.proposals[0]).toMatchObject({ kind: 'PACKAGE', packageId: 'SalesOrdersEU', spec: { id: 'SalesOrdersEU', name: 'Sales_Orders EU' } })
  })

  test('a default package Name is stored with its ID, and the iFlow proposal creates it with the Name', async () => {
    const { data, toolResult } = await propose('PkgName_6', 'TEAMEU', { defaults: { packageId: 'TEAM_EU' } })
    const { data: session } = await GET(`/api/ChatSessions/${data.sessionId}`)
    expect(JSON.parse(session.defaults)).toMatchObject({ packageId: 'TEAMEU', packageName: 'TEAM_EU' })
    const system = llm.chat.mock.calls.at(-1)[0].messages[0].content
    expect(system).toContain("The user named it 'TEAM_EU': Package ID will be TEAMEU (CPI does not allow underscores in IDs).")
    expect(toolResult.packageNote).toMatch(/approving creates it with the name 'TEAM_EU'/)
    const { data: stored } = await GET(`/api/Proposals/${data.proposals[0].ID}`)
    expect(stored).toMatchObject({ packageId: 'TEAMEU', packageName: 'TEAM_EU' })
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
    expect(done.result.steps.map((s) => `${s.key}:${s.status}`)).toEqual(['check:done', 'package:done', 'build:done', 'create:done', 'configure:done', 'deploy:done', 'runtime:done'])
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

  test("an update of a failed iFlow: the previous deployment's ERROR does not fail the new one", async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_OldError' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'redeploy' })
    const hourAgo = new Date(Date.now() - 3600_000).toISOString()
    cpi.getRuntimeArtifact.mockResolvedValue({ status: 'ERROR', deployedOn: hourAgo }) // the old version
    cpi.getDeployStatus.mockResolvedValue('DEPLOYING')
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: true })
    const done = await waitFor(data.proposals[0].ID)
    expect(done).toMatchObject({ status: 'DONE', result: { warning: expect.stringContaining('not running yet') } })
  })

  test("an update of a running iFlow: the previous deployment's STARTED is not taken as success", async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_OldStarted' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'redeploy running' })
    cpi.getRuntimeArtifact.mockResolvedValue({ status: 'STARTED', deployedOn: new Date(Date.now() - 3600_000).toISOString() })
    cpi.getDeployStatus.mockResolvedValue('DEPLOYING')
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: true })
    const done = await waitFor(data.proposals[0].ID)
    expect(done.result.runtimeStatus).not.toBe('STARTED')
    expect(done.result.warning).toMatch(/not running yet/)
  })

  test('the new deployment (deployed after the start) counts', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_NewStarted' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'deploy new' })
    cpi.getRuntimeArtifact.mockImplementation(async () => ({ status: 'STARTED', deployedOn: new Date().toISOString() }))
    cpi.getDeployStatus.mockResolvedValue('DEPLOYING')
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: true })
    const done = await waitFor(data.proposals[0].ID)
    expect(done).toMatchObject({ status: 'DONE', result: { runtimeStatus: 'STARTED' } })
  })

  test('a new-iFlow proposal does not overwrite an iFlow that appeared after it was proposed', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_Taken' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'create it' })
    cpi.getIflow.mockResolvedValueOnce({ id: 'Exec_Taken', packageId: 'PilotReference' }) // created meanwhile, e.g. by another proposal
    cpi.updateIflowContent.mockClear()
    await POST(`/api/Proposals/${data.proposals[0].ID}/approve`, { deploy: false })
    const failed = await waitFor(data.proposals[0].ID)
    expect(failed).toMatchObject({ status: 'FAILED', error: expect.stringContaining("An iFlow 'Exec_Taken' already exists") })
    expect(cpi.updateIflowContent).not.toHaveBeenCalled()
  })

  test('a retry updates the iFlow its own earlier attempt created', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Exec_Mine' } })).mockResolvedValueOnce(answer('ready'))
    const data = await chat({ message: 'create mine' })
    const id = data.proposals[0].ID
    cpi.updateConfiguration.mockRejectedValueOnce(new Error('configure failed')) // created, then failed
    await POST(`/api/Proposals/${id}/approve`, { deploy: false })
    expect(await waitFor(id)).toMatchObject({ status: 'FAILED' })
    cpi.getIflow.mockResolvedValueOnce({ id: 'Exec_Mine', packageId: 'PilotReference' })
    await POST(`/api/Proposals/${id}/retry`, {})
    const done = await waitFor(id)
    expect(done.status).toBe('DONE')
    expect(done.result.steps.find((s) => s.key === 'create').detail).toBe('Updated existing Exec_Mine in PilotReference')
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
    const defaults = { packageId: 'IntegrationPilot.Demo', timer: 'once', authNote: 'OAuth2 Client Credentials, credential DEMO_OAUTH' }
    llm.chat.mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ message: 'Create the iFlow', defaults })
    const system = llm.chat.mock.calls.at(-1)[0].messages[0].content
    expect(system).toContain('{"packageId":"IntegrationPilot.Demo","trigger":{"type":"timer","mode":"once"},"receiverAuthentication":"OAuth2 Client Credentials, credential DEMO_OAUTH"}')
    expect(system).toMatch(/never ask about them/)
    const { data: session } = await GET(`/api/ChatSessions/${turn.sessionId}`)
    expect(JSON.parse(session.defaults)).toEqual(defaults)

    // omitted: the stored defaults stay; empty: cleared
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: turn.sessionId, message: 'next' })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).toContain('"packageId":"IntegrationPilot.Demo"')
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: turn.sessionId, message: 'again', defaults: { packageId: '', timer: '', authNote: '' } })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).not.toContain('Session defaults')
  })

  test('invalid defaults are rejected', async () => {
    await expect(POST('/api/chat', { message: 'x', defaults: { packageId: '___' } })).rejects.toMatchObject({ response: { status: 400 } })
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
    const dir = `${__dirname}/fixtures/users-summary`
    const spec = JSON.parse(fs.readFileSync(`${dir}/spec.json`, 'utf8'))
    const attachments = { 'summarizeUsers.groovy': fs.readFileSync(`${dir}/summarizeUsers.groovy`, 'utf8'), 'buildErrorMessage.groovy': fs.readFileSync(`${dir}/buildErrorMessage.groovy`, 'utf8') }
    const { zipBase64 } = await build(spec, { attachments })

    const { data: imported } = await POST('/api/importIflow', { fileName: 'users-summary.zip', contentBase64: zipBase64, packageId: 'PilotReference' })
    expect(imported).toMatchObject({ valid: true, placeholders: 0, spec: { id: `${spec.id}_Imported`, packageId: 'PilotReference' } })
    expect(imported.attachments.sort()).toEqual(['buildErrorMessage.groovy', 'summarizeUsers.groovy'])
    const { data: messages } = await GET(`/api/ChatSessions/${imported.sessionId}/messages?$orderby=seq`)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toMatch(/^Imported \*\*Users Summary RUNID\*\*/)

    llm.chat
      .mockResolvedValueOnce(toolCall('validateSpec', { useDraftSpec: true }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ sessionId: imported.sessionId, message: 'Propose the imported iFlow as a new iFlow.' })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: `${spec.id}_Imported`, status: 'PENDING' })])
    const sent = llm.chat.mock.calls.at(-1)[0].messages
    expect(sent[0].content).toMatch(/Draft spec of this conversation \(imported from users-summary.zip\): Users_Summary_RUNID/)
    expect(sent[0].content).toContain('summarizeUsers.groovy (Groovy,')
    expect(JSON.stringify(sent)).not.toContain('openTodos[u.id]') // the script body never reaches the model
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

describe('Groovy syntax check', () => {
  const broken = { fileName: 'addLengthHeader', name: 'Add Length Header' }
  afterEach(() => {
    groovyCheck.checkScripts.mockImplementation(async () => ({ checked: true, errors: [] }))
    groovyCheck.required.mockImplementation(() => false)
  })

  test('syntax errors come back as compact GROOVY_SYNTAX lines; attached files say so', async () => {
    groovyCheck.checkScripts.mockImplementation(async (scripts) => ({
      checked: true,
      errors: scripts.map((s) => ({ fileName: s.fileName, line: 4, column: 7, message: "Unexpected input: 'return'" }))
    }))
    const spec = { ...sample, id: 'Agent_Groovy_1', steps: [sample.steps[0], { type: 'groovyScript', name: 'Map Users', fileName: 'mapUsers' }, sample.steps[1]] }
    llm.chat.mockResolvedValueOnce(toolCall('validateSpec', { spec })).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'Build it', attachments: [{ fileName: 'mapUsers.groovy', content: require('./helpers').GROOVY }] })
    const sent = groovyCheck.checkScripts.mock.calls.at(-1)[0]
    expect(sent.map((s) => s.fileName)).toEqual(['mapUsers.groovy', `${broken.fileName}.groovy`]) // attached and written scripts
    expect(sent[0].code).toBe(require('./helpers').GROOVY)
    const result = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
    expect(result).toEqual({
      valid: false,
      errors: [
        "GROOVY_SYNTAX mapUsers.groovy:4:7: Unexpected input: 'return' (attached file: tell the user to fix it and attach it again)",
        "GROOVY_SYNTAX addLengthHeader.groovy:4:7: Unexpected input: 'return'"
      ],
      instruction: 'Fix the scripts and call validateSpec again.'
    })
  })

  test('an unavailable checker is a warning, or an error when required', async () => {
    groovyCheck.checkScripts.mockImplementation(async () => ({ checked: false, errors: [], reason: 'GROOVY_CHECK_URL is not set' }))
    llm.chat.mockResolvedValueOnce(toolCall('validateSpec', { spec: { ...sample, id: 'Agent_Groovy_2' } })).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'Build it' })
    expect(JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)).toMatchObject({ valid: true, warnings: ['Groovy syntax not checked: GROOVY_CHECK_URL is not set'] })

    groovyCheck.required.mockImplementation(() => true)
    llm.chat.mockResolvedValueOnce(toolCall('validateSpec', { spec: { ...sample, id: 'Agent_Groovy_3' } })).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'Build it' })
    expect(JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)).toMatchObject({ valid: false, errors: [expect.stringMatching(/^GROOVY_NOT_CHECKED /)] })
  })

  test('proposeIflow with a spec checks the scripts too', async () => {
    groovyCheck.checkScripts.mockImplementation(async (scripts) => ({ checked: true, errors: [{ fileName: scripts[0].fileName, line: 1, column: 1, message: 'bad' }] }))
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Agent_Groovy_4' } })).mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ message: 'Build it' })
    expect(turn.proposals).toEqual([])
    expect(JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content).errors).toEqual(['GROOVY_SYNTAX addLengthHeader.groovy:1:1: bad'])
  })
})

describe('token usage', () => {
  const withUsage = (res, inputTokens, outputTokens, model = 'test/model') => ({ ...res, model, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, durationMs: 10 } })

  test('is summed per turn, stored on the turn and its answer, and summarized for the Activity page', async () => {
    llm.chat
      .mockResolvedValueOnce(withUsage(toolCall('listPackages', {}), 1000, 50))
      .mockResolvedValueOnce(withUsage(answer('Two packages.'), 1200, 80, 'test/fallback'))
    const turn = await chat({ message: 'Which packages are there?' })
    expect(turn).toMatchObject({ status: 'DONE', modelCalls: 2, inputTokens: 2200, outputTokens: 130, totalTokens: 2330, model: 'test/model, test/fallback' })
    expect(turn.durationMs).toBeGreaterThanOrEqual(0)

    const { data: messages } = await GET(`/api/ChatSessions/${turn.sessionId}/messages?$orderby=seq`)
    const answerMessage = messages.at(-1)
    expect(answerMessage.role).toBe('assistant')
    expect(JSON.parse(answerMessage.usage)).toMatchObject({ modelCalls: 2, inputTokens: 2200, outputTokens: 130, totalTokens: 2330 })
    expect(messages.filter((m) => m.usage).length).toBe(1) // only the final answer

    const { data: usage } = await GET('/api/usage(days=7)')
    expect(usage.days).toBe(7)
    expect(usage.totals.totalTokens).toBeGreaterThanOrEqual(2330)
    expect(usage.byDay[0]).toMatchObject({ day: new Date().toISOString().slice(0, 10) })
    expect(usage.byModel.map((m) => m.model)).toEqual(expect.arrayContaining(['test/model', 'test/fallback']))
  })

  test('a failed turn keeps the usage of the calls that answered', async () => {
    llm.chat
      .mockResolvedValueOnce(withUsage(toolCall('listPackages', {}), 500, 20))
      .mockRejectedValueOnce(Object.assign(new Error('The AI model did not answer within 120s.'), { status: 504, code: 'LLM_TIMEOUT' }))
    const turn = await chat({ message: 'x' })
    expect(turn).toMatchObject({ status: 'FAILED', modelCalls: 1, totalTokens: 520 })
  })
})

describe('backup before updates and restore', () => {
  const { build } = require('../srv/iflow-builder/builder')
  const { nextVersion } = require('../srv/lib/proposals')
  const current = { id: 'Backup_Me', name: 'Backup Me', packageId: 'PilotReference', trigger: { type: 'httpsSender', address: '/backup/me' }, steps: [{ type: 'jsonToXml' }], end: { type: 'none' } }
  let zip, proposalId

  beforeAll(async () => {
    zip = Buffer.from((await build(current)).zipBase64, 'base64')
    cpi.getIflow.mockImplementation(async (id) => {
      if (id === current.id) return { id, name: current.name, packageId: 'PilotReference', version: '1.0.4' }
      throw Object.assign(new Error('not found'), { status: 404 })
    })
    cpi.downloadIflowZip.mockImplementation(async () => zip)
  })
  afterAll(() =>
    cpi.getIflow.mockImplementation(async () => {
      throw Object.assign(new Error('not found'), { status: 404 })
    })
  )

  test('nextVersion bumps the patch level', () => {
    expect(nextVersion('1.0.4')).toBe('1.0.5')
    expect(nextVersion('active')).toBe('1.0.1')
  })

  test('an approved update stores the old zip and saves a CPI version first', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id }))
      .mockResolvedValueOnce(answer('read'))
    const first = await chat({ message: 'show it' })
    const spec = { ...JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content).spec, steps: [{ type: 'jsonToXml', name: 'To XML' }] }
    llm.chat
      .mockResolvedValueOnce(toolCall('validateSpec', { spec }))
      .mockResolvedValueOnce(toolCall('proposeIflowUpdate', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ sessionId: first.sessionId, message: 'rename the step' })
    proposalId = turn.proposals[0].ID
    cpi.saveIflowAsVersion.mockClear()
    cpi.updateIflowContent.mockClear()

    await POST(`/api/Proposals/${proposalId}/approve`, { deploy: false })
    const done = await waitFor(proposalId)
    expect(done.status).toBe('DONE')
    expect(done.result.steps.map((s) => s.key)).toEqual(['check', 'package', 'backup', 'build', 'create', 'configure'])
    expect(done.result.steps[2]).toMatchObject({ status: 'done', detail: expect.stringMatching(/^Backup of version 1.0.4 stored \(\d+ KB\); saved as CPI version 1.0.5$/) })
    expect(cpi.saveIflowAsVersion).toHaveBeenCalledWith(current.id, '1.0.5')
    // the version is saved before the content is replaced
    expect(cpi.saveIflowAsVersion.mock.invocationCallOrder[0]).toBeLessThan(cpi.updateIflowContent.mock.invocationCallOrder[0])
    expect(done.backup).toMatchObject({ iflowId: current.id, version: '1.0.4', savedVersion: '1.0.5', sizeBytes: zip.length })
    expect(done.backupZip).toBeUndefined() // never sent to the UI
  })

  test('the backups are listed and restored, audited as RESTORE_IFLOW', async () => {
    const { data: backups } = await GET(`/api/Iflows/${current.id}/backups()`)
    expect(backups[0]).toMatchObject({ proposalId, version: '1.0.4', savedVersion: '1.0.5' })

    cpi.updateIflowContent.mockClear()
    const { data: restored } = await POST(`/api/Iflows/${current.id}/restore`, {})
    expect(restored).toMatchObject({ iflowId: current.id, restoredFrom: { proposalId, version: '1.0.4' }, savedCurrentAs: '1.0.5' })
    expect(cpi.updateIflowContent).toHaveBeenCalledWith(current.id, { zipBase64: zip.toString('base64') })
    const { data: log } = await GET(`/api/AuditLog?$filter=action eq 'RESTORE_IFLOW'&$orderby=createdAt desc&$top=1`)
    expect(log[0]).toMatchObject({ targetId: current.id, status: 'SUCCESS' })

    await expect(POST(`/api/Iflows/Other_Flow/restore`, { proposalId })).rejects.toMatchObject({ response: { status: 400 } })
    await expect(POST(`/api/Iflows/No_Backups/restore`, {})).rejects.toMatchObject({ response: { status: 404 } })
  })

  test('a retry keeps the first backup instead of backing up its own changes', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id })).mockResolvedValueOnce(answer('read'))
    const first = await chat({ message: 'show it' })
    const spec = { ...JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content).spec, steps: [{ type: 'jsonToXml', name: 'Retry Me' }] }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflowUpdate', { spec })).mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ sessionId: first.sessionId, message: 'rename' })
    const id = turn.proposals[0].ID
    cpi.updateIflowContent.mockRejectedValueOnce(Object.assign(new Error('CPI busy'), { status: 503 }))
    await POST(`/api/Proposals/${id}/approve`, { deploy: false })
    expect((await waitFor(id)).status).toBe('FAILED')
    cpi.downloadIflowZip.mockClear()
    await POST(`/api/Proposals/${id}/retry`, {})
    const done = await waitFor(id)
    expect(done.status).toBe('DONE')
    expect(done.result.steps.find((s) => s.key === 'backup')).toMatchObject({ status: 'done', detail: 'Backup from an earlier attempt kept' })
    expect(cpi.downloadIflowZip).not.toHaveBeenCalled()
  })

  test('a failed CPI version save is a warning; the update goes on', async () => {
    cpi.saveIflowAsVersion.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    llm.chat
      .mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id }))
      .mockResolvedValueOnce(answer('read'))
    const first = await chat({ message: 'show it' })
    const spec = { ...JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content).spec, steps: [{ type: 'jsonToXml', name: 'Convert' }] }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflowUpdate', { spec })).mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ sessionId: first.sessionId, message: 'rename' })
    await POST(`/api/Proposals/${turn.proposals[0].ID}/approve`, { deploy: false })
    const done = await waitFor(turn.proposals[0].ID)
    expect(done.status).toBe('DONE')
    expect(done.result.steps.find((s) => s.key === 'backup')).toMatchObject({ status: 'warning', detail: expect.stringMatching(/the CPI version could not be saved: Forbidden/) })
  })
})

describe('streaming progress', () => {
  test('the running turn shows how much of the answer has arrived', async () => {
    let seen
    llm.chat.mockImplementationOnce(async ({ onProgress }) => {
      onProgress({ outputChars: 4, reasoningChars: 0 }) // too small to show
      onProgress({ outputChars: 4000, reasoningChars: 800 })
      await new Promise((r) => setTimeout(r, 50))
      const { data } = await GET(`/api/ChatTurns?$filter=status eq 'RUNNING'&$top=1`)
      seen = data[0]?.events.at(-1)
      return answer('done')
    })
    await chat({ message: 'Hello' })
    expect(seen).toMatchObject({ label: 'Thinking…', detail: '~1,200 tokens so far' })
  })
})

describe('writeScript', () => {
  const { GROOVY } = require('./helpers')
  afterEach(() => groovyCheck.checkScripts.mockImplementation(async () => ({ checked: true, errors: [] })))

  test('scripts are written as plain code, checked, stored, and referenced by the spec without code', async () => {
    groovyCheck.checkScripts.mockImplementationOnce(async () => ({ checked: true, errors: [{ fileName: 'mapUsers.groovy', line: 3, column: 9, message: "Unexpected input: '('" }] }))
    const spec = { ...sample, id: 'Agent_Script_1', steps: [sample.steps[0], { type: 'groovyScript', name: 'Map Users', fileName: 'mapUsers' }] }
    llm.chat
      .mockResolvedValueOnce(toolCall('writeScript', { fileName: 'mapUsers', code: GROOVY.replace('return message', 'return message }') }))
      .mockResolvedValueOnce(toolCall('writeScript', { fileName: 'mapUsers', code: 'println 1' }))
      .mockResolvedValueOnce(toolCall('writeScript', { fileName: 'mapUsers', code: GROOVY }))
      .mockResolvedValueOnce(toolCall('validateSpec', { spec }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ message: 'Build it' })
    const results = llm.chat.mock.calls.at(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
    expect(results[0]).toEqual({ valid: false, errors: ["GROOVY_SYNTAX mapUsers.groovy:3:9: Unexpected input: '('"], instruction: 'Fix the script and call writeScript again.' })
    expect(results[1].errors.map((e) => e.split(' ')[0])).toEqual(['GROOVY_IMPORT', 'GROOVY_ENTRY'])
    expect(results[2]).toEqual({ stored: 'mapUsers.groovy', lines: GROOVY.split('\n').length, next: 'Use it with { "type": "groovyScript", "fileName": "mapUsers" } and no "code".' })
    expect(results[3]).toMatchObject({ valid: true })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_Script_1' })])

    const { data: proposal } = await GET(`/api/Proposals/${turn.proposals[0].ID}`)
    expect(proposal.attachments).toEqual({ 'mapUsers.groovy': GROOVY })
    const { data: files } = await GET(`/api/Attachments?$filter=session_ID eq ${turn.sessionId}`)
    expect(files).toEqual([expect.objectContaining({ fileName: 'mapUsers.groovy', origin: 'ai' })])

    // within the turn only the newest version of the script went back to the model
    const sent = llm.chat.mock.calls.at(-1)[0].messages.filter((m) => m.tool_calls?.[0].function.name === 'writeScript').map((m) => JSON.parse(m.tool_calls[0].function.arguments).code)
    expect(sent.slice(0, 2)).toEqual([expect.stringMatching(/^\(older version omitted/), expect.stringMatching(/^\(older version omitted/)])
    expect(sent[2]).toBe(GROOVY)
    // the next turn's context names the file as written by the model
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: turn.sessionId, message: 'next' })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).toMatch(/mapUsers\.groovy \(Groovy, \d+ lines, written by you with writeScript\)/)
  })

  test("a file the user attached is not overwritten", async () => {
    llm.chat.mockResolvedValueOnce(toolCall('writeScript', { fileName: 'mine', code: GROOVY })).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'x', attachments: [{ fileName: 'mine.groovy', content: GROOVY }] })
    expect(JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content).errors).toEqual([expect.stringMatching(/^ATTACHED_BY_USER mine.groovy/)])
  })
})

describe('editDraftSpec: building a large spec in parts', () => {
  const cm = (n) => ({ type: 'contentModifier', name: `Step ${n}`, properties: [{ name: `P${n}`, type: 'constant', value: String(n) }] })
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => cm(from + i))

  test('set, add in chunks of 8, fix one step, validate the draft and propose it', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { id: 'Agent_Big_1', name: 'Agent Big 1', packageId: 'PilotReference', trigger: { type: 'timer', mode: 'once' }, end: { type: 'none' } } }, { op: 'addSteps', steps: range(1, 8) }] }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'addSteps', steps: [...range(9, 15), { type: 'router', name: 'Oops' }] }] }))
      .mockResolvedValueOnce(toolCall('validateSpec', { useDraftSpec: true }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'replaceStep', index: 15, step: cm(16) }, { op: 'addSteps', steps: [{ type: 'contentModifier', name: 'Set Error' }], exception: true }] }))
      .mockResolvedValueOnce(toolCall('validateSpec', { useDraftSpec: true }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useValidatedSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ message: 'Build a 16-step flow' })
    const results = llm.chat.mock.calls.at(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))

    expect(results[0]).toMatchObject({ saved: true, id: 'Agent_Big_1', steps: expect.arrayContaining(['0. Step 1 (contentModifier)', '7. Step 8 (contentModifier)']) })
    expect(results[0].next).toMatch(/propose it with \{ "useDraftSpec": true \}/)
    expect(results[1].openIssues).toEqual([expect.stringMatching(/^STEP_NOT_IN_V1 steps\[15\]: 'router'/)])
    expect(results[2]).toMatchObject({ valid: false, errors: [expect.stringMatching(/^STEP_NOT_IN_V1 steps\[15\]/)] })
    expect(results[3]).toMatchObject({ saved: true, exceptionSteps: ['0. Set Error (contentModifier)'] })
    expect(results[3].openIssues).toBeUndefined()
    expect(results[4]).toMatchObject({ valid: true })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_Big_1' })])
    const { data: proposal } = await GET(`/api/Proposals/${turn.proposals[0].ID}`)
    expect(proposal.spec.steps.map((s) => s.name)).toEqual(range(1, 16).map((s) => s.name))
    expect(proposal.spec.exceptionSubprocess.steps).toEqual([{ type: 'contentModifier', name: 'Set Error' }])
  })

  test('invalid operations change nothing; more than 8 steps per call are refused', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'addSteps', steps: [cm(1)] }] }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { id: 'Agent_Big_2', steps: [] } }] }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { id: 'Agent_Big_2' } }, { op: 'addSteps', steps: range(1, 9) }] }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { id: 'Agent_Big_2' } }, { op: 'removeStep', index: 3 }] }))
      .mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ message: 'x' })
    const results = llm.chat.mock.calls.at(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
    expect(results[0].errors).toEqual([expect.stringMatching(/^NO_DRAFT ops\[0\]: there is no draft yet/)])
    expect(results[1].errors).toEqual([expect.stringMatching(/^UNKNOWN_FIELD ops\[0\]: fields steps cannot be set here/)])
    expect(results[2].errors).toEqual([expect.stringMatching(/^TOO_MANY ops: 9 steps in one call/)])
    expect(results[3].errors).toEqual([expect.stringMatching(/^BAD_INDEX ops\[1\]: index 3 is not a step \(0..-1\)/)])
    for (const r of results) expect(r.instruction).toMatch(/^Nothing was changed/)
    const { data: session } = await GET(`/api/ChatSessions/${turn.sessionId}`)
    expect(session.draftSpec).toBeNull()
  })
})

describe('one call instead of parts', () => {
  test('a draft is proposed directly with useDraftSpec', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { id: 'Agent_Draft_Direct', name: 'Draft Direct', packageId: 'PilotReference', trigger: { type: 'timer', mode: 'once' }, end: { type: 'none' } } }, { op: 'addSteps', steps: [{ type: 'jsonToXml', name: 'To XML' }] }] }))
      .mockResolvedValueOnce(toolCall('proposeIflow', { useDraftSpec: true }))
      .mockResolvedValueOnce(answer('Ready.'))
    const turn = await chat({ message: 'Build it' })
    expect(turn.proposals).toEqual([expect.objectContaining({ iflowId: 'Agent_Draft_Direct' })])
    expect(llm.chat).toHaveBeenCalledTimes(3) // no validateSpec call in between
  })

  test('an answer cut off at the length limit is not used; the model is told to continue in parts', async () => {
    const cutOff = { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null, tool_calls: [{ id: 'p', type: 'function', function: { name: 'proposeIflow', arguments: '{"spec":{"id":"X","steps":[{"ty' } }] } }] }
    llm.chat.mockResolvedValueOnce(cutOff).mockResolvedValueOnce(answer('Continuing in parts.'))
    const turn = await chat({ message: 'Build a big one' })
    expect(turn.status).toBe('DONE')
    expect(turn.events.map((e) => e.label)).toContain('Answer cut off at the length limit — continuing in parts')
    const second = llm.chat.mock.calls.at(-1)[0].messages
    expect(second.at(-1)).toMatchObject({ role: 'user', content: expect.stringMatching(/^\[Integration Pilot\] Your previous response was cut off/) })
    expect(second.some((m) => m.tool_calls)).toBe(false) // the truncated tool call was dropped

    // the note is not part of later turns
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: turn.sessionId, message: 'next' })
    expect(JSON.stringify(llm.chat.mock.calls.at(-1)[0].messages)).not.toContain('[Integration Pilot]')
  })

  test('after repeated cut-offs the agent stops with a hint', async () => {
    const cutOff = { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'x' } }] }
    llm.chat.mockResolvedValueOnce(cutOff).mockResolvedValueOnce(cutOff).mockResolvedValueOnce(cutOff)
    const turn = await chat({ message: 'Build a huge one' })
    expect(turn.text).toMatch(/cut off several times/)
    expect(llm.chat).toHaveBeenCalledTimes(3)
  })
})

describe('fewer and smaller model inputs', () => {
  test('getSupportedSteps is compact and names every field of the schema', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('getSupportedSteps', {})).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'what can you build?' })
    const content = llm.chat.mock.calls.at(-1)[0].messages.at(-1).content
    expect(content.length).toBeLessThan(5000) // the full schema result was ~11k characters
    const { format } = JSON.parse(content)
    const schema = require('../srv/iflow-builder/spec-schema.json')
    for (const field of Object.keys(schema.properties)) expect(format.spec).toContain(field)
    for (const type of schema.definitions.step.properties.type.enum) {
      const def = schema.definitions[type === 'jsonToXml' || type === 'xmlToJson' ? 'converter' : type]
      for (const field of Object.keys(def.properties).filter((f) => f !== 'code')) expect(format.steps[type]).toContain(field)
    }
  })

  test('the default package is checked on the tenant, so the model need not list packages', async () => {
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'x', defaults: { packageId: 'PilotReference' } })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).toContain('It exists on the tenant: do not call listPackages or listIflows to check it.')
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'x', defaults: { packageId: 'Not.There' } })
    expect(llm.chat.mock.calls.at(-1)[0].messages[0].content).toContain('It does not exist on the tenant yet')
  })
})

describe('token budget per message', () => {
  const { GROOVY } = require('./helpers')
  const used = (res, tokens) => ({ ...res, model: 'test/model', usage: { inputTokens: tokens - 100, outputTokens: 100, totalTokens: tokens, durationMs: 5 } })
  afterEach(() => delete process.env.AGENT_MAX_TOKENS_PER_MESSAGE)

  test('stops at AGENT_MAX_TOKENS_PER_MESSAGE with what is done and left; "continue" resumes with the kept work', async () => {
    process.env.AGENT_MAX_TOKENS_PER_MESSAGE = '2000'
    llm.chat
      .mockResolvedValueOnce(used(toolCall('writeScript', { fileName: 'mapUsers', code: GROOVY }), 1200))
      .mockResolvedValueOnce(used(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { id: 'Agent_Budget_1', name: 'Budget', packageId: 'PilotReference', trigger: { type: 'timer', mode: 'once' }, end: { type: 'none' } } }] }), 1200))
    const turn = await chat({ message: 'Build a large flow' })
    expect(llm.chat).toHaveBeenCalledTimes(2) // the third call would exceed the budget
    expect(turn).toMatchObject({ status: 'DONE', stoppedAtBudget: true, tokenBudget: 2000, totalTokens: 2400 })
    expect(turn.text).toMatch(/^I stopped because this message reached its token budget \(2k of 2k tokens\)\./)
    expect(turn.text).toContain('Done so far: scripts written: mapUsers.groovy; draft spec Agent_Budget_1 with 0 steps.')
    expect(turn.text).toContain('Left: complete the spec and propose the iFlow.')
    expect(turn.text).toContain('send "continue" to resume')

    // "continue": a new budget; the draft and the script are in the context, not redone
    delete process.env.AGENT_MAX_TOKENS_PER_MESSAGE
    llm.chat.mockResolvedValueOnce(used(answer('Resuming.'), 500))
    await chat({ sessionId: turn.sessionId, message: 'continue' })
    const system = llm.chat.mock.calls.at(-1)[0].messages[0].content
    expect(system).toMatch(/Draft spec of this conversation \(built with editDraftSpec\): Agent_Budget_1/)
    expect(system).toMatch(/mapUsers\.groovy \(Groovy, \d+ lines, written by you with writeScript\)/)

    const { data: usage } = await GET('/api/usage(days=1)')
    expect(usage.budget).toMatchObject({ limit: 300000, stoppedAtBudget: expect.any(Number) })
    expect(usage.budget.stoppedAtBudget).toBeGreaterThanOrEqual(1)
  })
})

describe('Groovy check at proposal and approval', () => {
  const down = async () => ({ checked: false, errors: [], reason: 'fetch failed (ECONNREFUSED) at http://localhost:4010' })
  afterEach(() => groovyCheck.checkScripts.mockImplementation(async () => ({ checked: true, errors: [] })))
  const propose = async (id) => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id } })).mockResolvedValueOnce(answer('ok'))
    const turn = await chat({ message: 'Build it' })
    return turn.proposals[0].ID
  }

  test('a script not checked at proposal time is marked; approval needs acceptUnchecked while the check is down', async () => {
    groovyCheck.checkScripts.mockImplementation(down)
    const id = await propose('Agent_Unchecked_1')
    const { data: pending } = await GET(`/api/Proposals/${id}`)
    expect(pending.scriptChecks).toEqual({ 'addLengthHeader.groovy': { status: 'unchecked', reason: 'fetch failed (ECONNREFUSED) at http://localhost:4010', at: expect.any(String) } })

    await expect(POST(`/api/Proposals/${id}/approve`, { deploy: false })).rejects.toMatchObject({ response: { status: 409, data: { error: { code: 'GROOVY_NOT_CHECKED' } } } })
    expect((await GET(`/api/Proposals/${id}`)).data.status).toBe('PENDING')

    await POST(`/api/Proposals/${id}/approve`, { deploy: false, acceptUnchecked: true })
    const done = await waitFor(id)
    expect(done.status).toBe('DONE')
    expect(done.result.steps[0]).toMatchObject({ key: 'check', status: 'warning', detail: expect.stringMatching(/^Not checked \(fetch failed/) })
    const { data: log } = await GET(`/api/AuditLog?$filter=targetId eq '${id}' and action eq 'APPROVE_PROPOSAL'`)
    expect(JSON.parse(log[0].details)).toMatchObject({ acceptedUncheckedGroovy: true })
  })

  test('a syntax error found at approval blocks it; the proposal stays pending with the error', async () => {
    const id = await propose('Agent_Recheck_1')
    expect((await GET(`/api/Proposals/${id}`)).data.scriptChecks['addLengthHeader.groovy'].status).toBe('ok')
    groovyCheck.checkScripts.mockImplementation(async (scripts) => ({ checked: true, errors: [{ fileName: scripts[0].fileName, line: 4, column: 2, message: "Unexpected input: '}'" }] }))
    await expect(POST(`/api/Proposals/${id}/approve`, { deploy: false, acceptUnchecked: true })).rejects.toMatchObject({
      response: { status: 409, data: { error: { code: 'GROOVY_SYNTAX', message: "Approval blocked: 1 Groovy syntax error(s): addLengthHeader.groovy:4:2: Unexpected input: '}'" } } }
    })
    const { data } = await GET(`/api/Proposals/${id}`)
    expect(data.status).toBe('PENDING')
    expect(data.scriptChecks['addLengthHeader.groovy']).toMatchObject({ status: 'failed', errors: ["4:2: Unexpected input: '}'"] })
  })

  test('checked scripts: the approval step says so', async () => {
    const id = await propose('Agent_Recheck_2')
    await POST(`/api/Proposals/${id}/approve`, { deploy: false })
    const done = await waitFor(id)
    expect(done.result.steps[0]).toMatchObject({ key: 'check', status: 'done', detail: '1 script(s) checked, no syntax errors' })
  })
})

describe('update with new script code (manual test 16)', () => {
  const { build } = require('../srv/iflow-builder/builder')
  const JSZip = require('jszip')
  const OLD = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    messageLogFactory.getMessageLog(message)?.setStringProperty('Old', 'yes')
    return message
}
`
  const NEW = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    def body = message.getBody(String) ?: ''
    messageLogFactory.getMessageLog(message)?.addAttachmentAsString('Notification', body, 'text/plain')
    return message
}
`
  const current = {
    id: 'Notify_Update',
    name: 'Notify Update',
    packageId: 'PilotReference',
    trigger: { type: 'httpsSender', address: '/pilot/notify-update' },
    steps: [{ type: 'groovyScript', name: 'Groovy Script 1', fileName: 'addNotificationAttachment' }],
    end: { type: 'none' }
  }
  const userMessage = `Update Notify_Update. Replace the script with this code, use it verbatim:\n${NEW}`
  const lastToolResult = () => JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)

  beforeAll(async () => {
    const zip = Buffer.from((await build(current, { attachments: { 'addNotificationAttachment.groovy': OLD } })).zipBase64, 'base64')
    cpi.getIflow.mockImplementation(async (id) => {
      if (id === current.id) return { id, name: current.name, packageId: 'PilotReference', version: '1.0.0' }
      throw Object.assign(new Error('not found'), { status: 404 })
    })
    cpi.downloadIflowZip.mockImplementation(async () => zip)
  })
  afterAll(() =>
    cpi.getIflow.mockImplementation(async () => {
      throw Object.assign(new Error('not found'), { status: 404 })
    })
  )

  test('a script written before getIflowSpec is kept, and the proposal and answer show it as changed', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('writeScript', { fileName: 'addNotificationAttachment', code: NEW }))
      .mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id }))
      .mockResolvedValueOnce(toolCall('proposeIflowUpdate', { useDraftSpec: true }))
      .mockResolvedValueOnce(answer('Done. The script was replaced with your exact code.'))
    const turn = await chat({ message: userMessage })

    // getIflowSpec did not overwrite the script the model had written
    const read = JSON.parse(llm.chat.mock.calls.at(-2)[0].messages.at(-1).content)
    expect(read).toMatchObject({ editable: true, keptFiles: ['addNotificationAttachment.groovy'] })
    const { data: files } = await GET(`/api/Attachments?$filter=session_ID eq ${turn.sessionId}`)
    expect(files).toEqual([expect.objectContaining({ fileName: 'addNotificationAttachment.groovy', origin: 'ai' })])

    const { data: p } = await GET(`/api/Proposals/${turn.proposals[0].ID}`)
    expect(p.attachments['addNotificationAttachment.groovy']).toBe(NEW)
    // a script-only change is reported once, as the script (not also as "step settings changed")
    expect(p.changes).toEqual({ list: ['script addNotificationAttachment.groovy changed'], scripts: { 'addNotificationAttachment.groovy': 'changed' } })
    // the answer ends with the actual changes, not the model's account of them
    expect(turn.text).toMatch(/\n---\n\*\*What changed in Notify_Update\*\* \(from the proposal, compared with the current iFlow\):\n/)
    expect(turn.text).toContain('- Script `addNotificationAttachment.groovy`: changed')
  })

  test("a script of the same name written for another iFlow does not replace this iFlow's script (review)", async () => {
    // conversation: a script written for Other_Flow and proposed with it
    llm.chat.mockResolvedValueOnce(toolCall('writeScript', { fileName: 'addNotificationAttachment', code: NEW })).mockResolvedValueOnce(answer('written'))
    const first = await chat({ message: 'write the script for Other_Flow' })
    await INSERT.into('iflowpilot.Proposal').entries({ session_ID: first.sessionId, kind: 'IFLOW', iflowId: 'Other_Flow', packageId: 'PilotReference', spec: '{}', attachments: JSON.stringify({ 'addNotificationAttachment.groovy': NEW }), createdBy: 'local-dev' })
    // then Notify_Update is loaded in the same conversation
    llm.chat.mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id })).mockResolvedValueOnce(answer('loaded'))
    await chat({ sessionId: first.sessionId, message: 'now look at Notify_Update' })
    const read = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
    expect(read).toMatchObject({ editable: true, replacedScripts: ['addNotificationAttachment.groovy'] })
    expect(read.keptFiles).toBeUndefined()
    const { data: files } = await GET(`/api/Attachments?$filter=session_ID eq ${first.sessionId}`)
    expect(files).toEqual([expect.objectContaining({ fileName: 'addNotificationAttachment.groovy', origin: 'iflow' })])
  })

  test('code in the message but the script left unchanged: refused before proposing (SCRIPT_UNCHANGED)', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { description: 'Script fixed' } }] }))
      .mockResolvedValueOnce(toolCall('proposeIflowUpdate', { useDraftSpec: true }))
      .mockResolvedValueOnce(answer('could not'))
    const turn = await chat({ message: userMessage })
    expect(lastToolResult()).toEqual({ valid: false, errors: [expect.stringMatching(/^SCRIPT_UNCHANGED addNotificationAttachment\.groovy: the user's message contains Groovy code, but this update keeps the iFlow's scripts unchanged/)] })
    expect(turn.proposals).toEqual([])
  })

  test('without code in the message, a description-only update is allowed and the answer says the script is unchanged', async () => {
    llm.chat
      .mockResolvedValueOnce(toolCall('getIflowSpec', { iflowId: current.id }))
      .mockResolvedValueOnce(toolCall('editDraftSpec', { ops: [{ op: 'set', fields: { description: 'Adds the body as an attachment' } }] }))
      .mockResolvedValueOnce(toolCall('proposeIflowUpdate', { useDraftSpec: true }))
      .mockResolvedValueOnce(answer('The script was replaced.')) // a false claim by the model
    const turn = await chat({ message: 'Update Notify_Update: change only the description to "Adds the body as an attachment".' })
    const { data: p } = await GET(`/api/Proposals/${turn.proposals[0].ID}`)
    expect(p.changes).toEqual({ list: ['description changed'], scripts: { 'addNotificationAttachment.groovy': 'unchanged' } })
    expect(turn.text).toContain('- description changed\n- Script `addNotificationAttachment.groovy`: unchanged from the iFlow')
  })

  test('the built zip contains every script at the path its step references', async () => {
    const { data: proposals } = await GET(`/api/Proposals?$filter=iflowId eq '${current.id}'&$orderby=createdAt`)
    const p = proposals[0]
    const { zipBase64 } = await build(p.spec, { attachments: p.attachments })
    const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
    const iflw = await zip.file(/\.iflw$/)[0].async('string')
    const refs = [...iflw.matchAll(/<key>script<\/key>\s*<value>([^<]+)<\/value>/g)].map((m) => m[1])
    expect(refs).toEqual(['addNotificationAttachment.groovy'])
    for (const ref of refs) expect(await zip.file(`src/main/resources/script/${ref}`)?.async('string')).toBe(NEW)
  })
})

describe('header and property types (system prompt review, item 3)', () => {
  test('proposeIflow stores a plain-value expression as constant and tells the model', async () => {
    const spec = { ...sample, id: 'Types_1', name: 'Types 1', steps: [{ type: 'contentModifier', name: 'Set Source', properties: [{ name: 'Source', type: 'expression', value: 'Shop' }] }] }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec })).mockResolvedValueOnce(answer('ready'))
    const turn = await chat({ message: 'propose Types_1' })
    const result = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
    expect(result).toMatchObject({ valid: true, autoFixes: ['type expression -> constant (the value has no ${...}): Set Source: property Source'] })
    expect(turn.proposals[0].spec.steps[0].properties).toEqual([{ name: 'Source', type: 'constant', value: 'Shop' }])
  })
})

describe('placeholder parameter defaults (system prompt review, item 4)', () => {
  test('only a URL with <...> is a placeholder: a default that contains XML is configured', async () => {
    const spec = { ...sample, id: 'Xml_Default_1', name: 'Xml Default 1', parameters: { ...sample.parameters, Template: '<root><item>1</item></root>' } }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec })).mockResolvedValueOnce(answer('ready'))
    const turn = await chat({ message: 'propose Xml_Default_1' })
    cpi.updateConfiguration.mockClear()
    await POST(`/api/Proposals/${turn.proposals[0].ID}/approve`, { deploy: false })
    const done = await waitFor(turn.proposals[0].ID)
    expect(done.result.steps.find((s) => s.key === 'configure')).toMatchObject({ status: 'done' })
    expect(cpi.updateConfiguration).toHaveBeenCalledWith('Xml_Default_1', 'Template', '<root><item>1</item></root>')
  })

  test('a placeholder default is not configured, and the iFlow is not deployed while one is left', async () => {
    const spec = { ...sample, id: 'Placeholder_URL_1', name: 'Placeholder URL 1', parameters: { ReceiverURL: 'https://<tenant>-rt.example.com/http/notify' } }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec })).mockResolvedValueOnce(answer('ready'))
    const turn = await chat({ message: 'propose Placeholder_URL_1' })
    cpi.updateConfiguration.mockClear()
    cpi.deployIflow.mockClear()

    await POST(`/api/Proposals/${turn.proposals[0].ID}/approve`, { deploy: true })
    const done = await waitFor(turn.proposals[0].ID)
    expect(done.status).toBe('DONE')
    const step = (key) => done.result.steps.find((s) => s.key === key)
    expect(step('configure')).toMatchObject({ status: 'warning', detail: expect.stringMatching(/^Not configured, the default is a placeholder: ReceiverURL\. Set the real value in the CPI web editor \(Configure\) before deploying\.$/) })
    expect(step('deploy')).toMatchObject({ status: 'warning', detail: expect.stringMatching(/^Not deployed: ReceiverURL still has a placeholder/) })
    expect(step('runtime')).toMatchObject({ status: 'skipped' })
    expect(cpi.updateConfiguration).not.toHaveBeenCalled()
    expect(cpi.deployIflow).not.toHaveBeenCalled()
  })
})

describe('receiver URL with a query (Test 3)', () => {
  test('approval configures the parameter with the URL before the query', async () => {
    const spec = { ...sample, id: 'Query_URL_1', name: 'Query URL 1', parameters: { ReceiverURL: 'https://services.odata.org/V2/Northwind/Northwind.svc/Products?$format=json&$top=20' } }
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec })).mockResolvedValueOnce(answer('ready'))
    const turn = await chat({ message: 'propose Query_URL_1' })
    cpi.updateConfiguration.mockClear()
    await POST(`/api/Proposals/${turn.proposals[0].ID}/approve`, { deploy: false })
    expect(await waitFor(turn.proposals[0].ID)).toMatchObject({ status: 'DONE' })
    expect(cpi.updateConfiguration).toHaveBeenCalledWith('Query_URL_1', 'ReceiverURL', 'https://services.odata.org/V2/Northwind/Northwind.svc/Products')
  })
})

describe('streaming lint in writeScript (Test 3)', () => {
  test('a script that parses the body as a String is stored, with a warning', async () => {
    const code = 'import com.sap.gateway.ip.core.customdev.util.Message\nimport groovy.json.JsonSlurper\n\ndef Message processData(Message message) {\n    def json = new JsonSlurper().parseText(message.getBody(String))\n    return message\n}\n'
    llm.chat.mockResolvedValueOnce(toolCall('writeScript', { fileName: 'parseBody', code })).mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'write it' })
    const result = JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
    expect(result).toMatchObject({ stored: 'parseBody.groovy', warnings: [expect.stringMatching(/^parseBody\.groovy:5: parses the whole message body as a String/)] })
  })
})

describe('conditional system prompt sections', () => {
  const fs = require('fs')
  const CORE = fs.readFileSync(`${__dirname}/../srv/agent/system-prompt.md`, 'utf8')
  const systemOf = (n = -1) => llm.chat.mock.calls.at(n)[0].messages[0].content

  test('a plain request gets the core only; the core is the identical beginning of every call', async () => {
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ message: 'Create an iFlow that posts the order to https://example.org/orders' })
    const system = systemOf()
    expect(system.startsWith(CORE)).toBe(true)
    expect(system.slice(CORE.length)).toMatch(/^\n\n## Context\n/)
    expect(system).not.toContain('## Unsupported steps')
  })

  test('mentioning an unsupported step adds the section, and it stays for the rest of the conversation (sticky)', async () => {
    llm.chat.mockResolvedValueOnce(answer('ok'))
    const first = await chat({ message: 'Create an iFlow with a router and a splitter' })
    expect(systemOf().startsWith(CORE + '\n\n## Unsupported steps\n')).toBe(true)
    llm.chat.mockResolvedValueOnce(answer('ok'))
    await chat({ sessionId: first.sessionId, message: 'Use package P.' })
    expect(systemOf()).toContain('\n\n## Unsupported steps\n')
    const { data: session } = await GET(`/api/ChatSessions/${first.sessionId}`)
    expect(JSON.parse(session.promptSections)).toEqual(['unsupportedSteps'])
  })

  test('files add the attached-files section; sections keep a fixed order, whatever came first', async () => {
    llm.chat.mockResolvedValueOnce(answer('ok'))
    const first = await chat({ message: 'Add a router' })
    llm.chat.mockResolvedValueOnce(answer('ok'))
    const groovy = 'import com.sap.gateway.ip.core.customdev.util.Message\ndef Message processData(Message message) { return message }\n'
    await chat({ sessionId: first.sessionId, message: 'Use my script', attachments: [{ fileName: 'mine.groovy', content: groovy }] })
    const system = systemOf()
    expect(system.startsWith(CORE + '\n\n## Attached files (details)\n')).toBe(true) // attachedFiles before unsupportedSteps
    expect(system.indexOf('## Attached files (details)')).toBeLessThan(system.indexOf('## Unsupported steps'))
    expect(system.indexOf('## Unsupported steps')).toBeLessThan(system.indexOf('## Context'))
  })
})

describe('package not given (measurement (e): the model chose PilotReference itself)', () => {
  beforeEach(() => (process.env.AGENT_ASK_PACKAGE = 'true'))
  afterEach(() => (process.env.AGENT_ASK_PACKAGE = 'false'))
  const lastToolResult = () => JSON.parse(llm.chat.mock.calls.at(-1)[0].messages.at(-1).content)
  const spec = (id) => ({ ...sample, id, name: id })

  test('first message without a package: refused, the model is told to ask with suggestions', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: spec('Ask_Pkg_1') })).mockResolvedValueOnce(answer('Which package should I use?'))
    const turn = await chat({ message: 'Every hour get users from https://jsonplaceholder.typicode.com/users and post them to https://httpbin.org/post' })
    expect(lastToolResult()).toMatchObject({
      valid: false,
      errors: ['PACKAGE_NOT_GIVEN packageId: the user did not name a target package and there is no session default'],
      instruction: expect.stringMatching(/^Nothing was proposed\. Ask the user which package to use, e\.g\. PilotReference \(Pilot Reference\)/)
    })
    expect(turn.proposals).toEqual([])

    // the user answers; from the second message on, the proposal goes through
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: spec('Ask_Pkg_1') })).mockResolvedValueOnce(answer('ready'))
    const next = await chat({ sessionId: turn.sessionId, message: 'Use sensible defaults.' })
    expect(next.proposals).toEqual([expect.objectContaining({ iflowId: 'Ask_Pkg_1', packageId: 'PilotReference' })])
  })

  test('a package named in the message (ID or name) or a session default is enough', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: spec('Ask_Pkg_2') })).mockResolvedValueOnce(answer('ready'))
    expect((await chat({ message: 'Build it in package Pilot Reference' })).proposals).toHaveLength(1)
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: spec('Ask_Pkg_3') })).mockResolvedValueOnce(answer('ready'))
    expect((await chat({ message: 'Build it in PilotReference' })).proposals).toHaveLength(1)
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: spec('Ask_Pkg_4') })).mockResolvedValueOnce(answer('ready'))
    expect((await chat({ message: 'Build it', defaults: { packageId: 'PilotReference' } })).proposals).toHaveLength(1)
  })
})

describe('cut-off answers keep their finished tool calls ((d) run: 3 cut-offs of up to 16k tokens each)', () => {
  const script = (n) => `import com.sap.gateway.ip.core.customdev.util.Message\n\ndef Message processData(Message message) {\n    message.setProperty('${n}', 'x')\n    return message\n}\n`
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } })
  const cutOff = (calls) => ({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null, tool_calls: calls } }] })

  test('finished writeScript calls are run; only the unfinished one is redone', async () => {
    const full = (n) => JSON.stringify({ fileName: n, code: script(n) })
    llm.chat
      .mockResolvedValueOnce(cutOff([call('c1', 'writeScript', full('first')), call('c2', 'writeScript', full('second')), call('c3', 'writeScript', full('third').slice(0, 40))]))
      .mockResolvedValueOnce(toolCall('writeScript', { fileName: 'third', code: script('third') }))
      .mockResolvedValueOnce(answer('done'))
    const turn = await chat({ message: 'write three scripts' })
    const { data: files } = await GET(`/api/Attachments?$filter=session_ID eq ${turn.sessionId}&$orderby=fileName`)
    expect(files.map((f) => f.fileName)).toEqual(['first.groovy', 'second.groovy', 'third.groovy'])
    // the second model call sees the two results and the note; no repeated work
    const second = llm.chat.mock.calls.at(-2)[0].messages
    expect(second.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content).stored)).toEqual(['first.groovy', 'second.groovy'])
    expect(second.at(-1).content).toMatch(/Its finished tool calls were run and their results are above \(writeScript first, writeScript second\); only the unfinished part was dropped\. .*at most 3 writeScript calls per answer/)
    expect(turn.events.map((e) => e.label)).toContain('Answer cut off at the length limit — kept 2 finished tool call(s), continuing')
    expect(turn.status).toBe('DONE')
  })

  test('without a finished tool call the answer is dropped as before', async () => {
    llm.chat.mockResolvedValueOnce(cutOff([call('c1', 'writeScript', '{"fileName":"half","code":"impo')])).mockResolvedValueOnce(answer('done'))
    const turn = await chat({ message: 'write one script' })
    const { data: files } = await GET(`/api/Attachments?$filter=session_ID eq ${turn.sessionId}`)
    expect(files).toEqual([])
    expect(turn.events.map((e) => e.label)).toContain('Answer cut off at the length limit — continuing in parts')
  })
})

describe('conversations are private (full review #5)', () => {
  const asB = { headers: { 'x-test-user': 'user-b' } }
  const groovy = 'import com.sap.gateway.ip.core.customdev.util.Message\ndef Message processData(Message message) { return message }\n'
  const status = (p) => p.then((r) => r.status, (e) => e.response?.status)

  test('user B cannot read user A conversation, messages, turns or attachments', async () => {
    llm.chat.mockResolvedValueOnce(answer('hello A'))
    const a = await chat({ message: 'A asks', attachments: [{ fileName: 'mine.groovy', content: groovy }] })
    // A sees everything
    expect((await GET(`/api/ChatSessions/${a.sessionId}`)).status).toBe(200)
    // B sees nothing of it
    expect(await status(GET(`/api/ChatSessions/${a.sessionId}`, asB))).toBe(404)
    expect((await GET('/api/ChatSessions', asB)).data.map((s) => s.ID)).not.toContain(a.sessionId)
    expect((await GET(`/api/ChatMessages?$filter=session_ID eq ${a.sessionId}`, asB)).data).toEqual([])
    expect(await status(GET(`/api/ChatTurns/${a.turnId}`, asB))).toBe(404)
    expect(await status(GET(`/api/chat/turns/${a.turnId}`, asB))).toBe(404)
    expect((await GET(`/api/Attachments?$filter=session_ID eq ${a.sessionId}`, asB)).data).toEqual([])
  })

  test('user B cannot change user A conversation: send, rename, delete, import, remove an attachment, cancel a turn', async () => {
    llm.chat.mockResolvedValueOnce(answer('hello A'))
    const a = await chat({ message: 'A asks', attachments: [{ fileName: 'mine.groovy', content: groovy }] })
    const [att] = (await GET(`/api/Attachments?$filter=session_ID eq ${a.sessionId}`)).data
    expect(await status(POST('/api/chat', { sessionId: a.sessionId, message: 'B writes' }, asB))).toBe(404)
    expect(await status(POST(`/api/ChatSessions/${a.sessionId}/rename`, { title: 'taken over' }, asB))).toBe(404)
    expect(await status(POST(`/api/ChatSessions/${a.sessionId}/remove`, {}, asB))).toBe(404)
    expect(await status(POST(`/api/Attachments/${att.ID}/remove`, {}, asB))).toBe(404)
    const { build } = require('../srv/iflow-builder/builder')
    const zip = (await build({ ...sample, id: 'Private_Import' })).zipBase64
    expect(await status(POST('/api/importIflow', { sessionId: a.sessionId, fileName: 'x.zip', contentBase64: zip }, asB))).toBe(404)

    // a running turn of A cannot be cancelled by B
    let release
    llm.chat.mockImplementationOnce(() => new Promise((r) => (release = () => r(answer('done')))))
    const { data: running } = await POST('/api/chat', { sessionId: a.sessionId, message: 'slow' })
    expect(await status(POST(`/api/ChatTurns/${running.turnId}/cancel`, {}, asB))).toBe(404)
    release()

    // nothing of A changed
    const { data: session } = await GET(`/api/ChatSessions/${a.sessionId}`)
    expect(session.title).not.toBe('taken over')
    expect((await GET(`/api/Attachments?$filter=session_ID eq ${a.sessionId}`)).data).toHaveLength(1)
  })

  test('proposals stay visible to all admins', async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Shared_Proposal', name: 'Shared Proposal' } })).mockResolvedValueOnce(answer('ready'))
    const a = await chat({ message: 'propose it' })
    expect((await GET(`/api/Proposals/${a.proposals[0].ID}`, asB)).data).toMatchObject({ iflowId: 'Shared_Proposal' })
  })

  test("a proposal does not lead into its private conversation: no $expand or $filter through it (review: B read A's messages)", async () => {
    llm.chat.mockResolvedValueOnce(toolCall('proposeIflow', { spec: { ...sample, id: 'Secret_Proposal', name: 'Secret Proposal' } })).mockResolvedValueOnce(answer('ready'))
    const a = await chat({ message: 'SECRET request of A' })
    const id = a.proposals[0].ID
    expect(await status(GET(`/api/Proposals/${id}?$expand=session($expand=messages)`, asB))).toBe(400)
    expect(await status(GET(`/api/Proposals?$expand=session`, asB))).toBe(400)
    expect(await status(GET(`/api/Proposals?$filter=session/messages/any(m:contains(m/content,'SECRET'))`, asB))).toBe(400)
    expect(await status(GET(`/api/Proposals/${id}/session`, asB))).toBe(404)
    // what the UI uses still works: the conversation's id, and filtering by it
    expect((await GET(`/api/Proposals/${id}`, asB)).data.session_ID).toBe(a.sessionId)
    expect((await GET(`/api/Proposals?$filter=session_ID eq ${a.sessionId}`)).data.map((p) => p.ID)).toEqual([id])
  })
})

describe('stuck turns (one instance; review: a RUNNING turn blocked its conversation forever)', () => {
  test('a RUNNING turn older than the maximum turn time is marked FAILED; the conversation is usable again', async () => {
    llm.chat.mockResolvedValueOnce(answer('first'))
    const first = await chat({ message: 'first' })
    const stuckId = cds.utils.uuid()
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
    await INSERT.into('iflowpilot.ChatTurn').entries({ ID: stuckId, session_ID: first.sessionId, status: 'RUNNING', message: 'left by a crashed instance', events: '[]', createdAt: twoHoursAgo, createdBy: 'local-dev' })

    llm.chat.mockResolvedValueOnce(answer('works again'))
    const next = await chat({ sessionId: first.sessionId, message: 'next' }) // was 409 TURN_IN_PROGRESS
    expect(next.status).toBe('DONE')
    const { data: stuck } = await GET(`/api/chat/turns/${stuckId}`)
    expect(stuck).toMatchObject({ status: 'FAILED', error: { code: 'TURN_STALE' } })
    const { data: msgs } = await GET(`/api/ChatSessions/${first.sessionId}/messages?$orderby=seq`)
    expect(msgs.map((m) => m.content)).toEqual(expect.arrayContaining(['left by a crashed instance', expect.stringMatching(/did not finish/)]))
  })

  test('a recent RUNNING turn still blocks (it may be working)', async () => {
    llm.chat.mockResolvedValueOnce(answer('first'))
    const first = await chat({ message: 'first' })
    await INSERT.into('iflowpilot.ChatTurn').entries({ ID: cds.utils.uuid(), session_ID: first.sessionId, status: 'RUNNING', message: 'busy', events: '[]', createdBy: 'local-dev' })
    await expect(POST('/api/chat', { sessionId: first.sessionId, message: 'next' })).rejects.toMatchObject({ response: { status: 409 } })
  })

  test('a turn that runs past the maximum turn time is stopped and ends FAILED', async () => {
    process.env.AGENT_MAX_TURN_MS = '300'
    try {
      // a model call that only ends when it is aborted, like the real one
      llm.chat.mockImplementationOnce(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })))))
      const turn = await chat({ message: 'never ends' })
      expect(turn).toMatchObject({ status: 'FAILED', error: { code: 'TURN_TIMEOUT', message: 'The message took longer than 0 minutes and was stopped.' } })
    } finally {
      delete process.env.AGENT_MAX_TURN_MS
    }
  })
})
