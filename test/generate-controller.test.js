/**
 * Generate page controller: switching conversations while requests are in flight (full review #9).
 * The controller is loaded with stubbed UI5 dependencies; the API's answers are released by the test
 * in a chosen order, so the races are deterministic.
 */
const path = require('path')

const WEBAPP = path.join(__dirname, '../app/integration-pilot/webapp')

/** Loads a sap.ui.define module and returns its factory */
function factoryOf(file) {
  let factory
  global.sap = { ui: { define: (_deps, f) => (factory = f) } }
  jest.isolateModules(() => require(file))
  delete global.sap
  return factory
}

/** A promise the test resolves later */
function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

/** Minimal JSON model: getProperty/setProperty on '/a/b' paths */
function model(data) {
  const at = (p) => p.split('/').filter(Boolean)
  return {
    data,
    getProperty: (p) => at(p).reduce((o, k) => (o == null ? undefined : o[k]), data),
    setProperty: (p, v) => {
      const keys = at(p)
      const last = keys.pop()
      keys.reduce((o, k) => (o[k] ??= {}), data)[last] = v
    }
  }
}

function controller() {
  const api = { calls: [], q: (o) => `?${new URLSearchParams(o)}`, seg: (s) => s }
  api.get = jest.fn((url) => {
    const d = deferred()
    api.calls.push({ url, ...d })
    return d.promise
  })
  api.post = jest.fn((url) => {
    const d = deferred()
    api.calls.push({ url, ...d })
    return d.promise
  })
  const promptLint = factoryOf(path.join(WEBAPP, 'util/promptLint.js'))()
  const markdown = factoryOf(path.join(WEBAPP, 'util/markdown.js'))()
  const BaseController = { extend: (_name, proto) => proto }
  const proto = factoryOf(path.join(WEBAPP, 'controller/Generate.controller.js'))(BaseController, function () {}, null, null, null, null, null, null, api, markdown, {}, promptLint)
  const ctl = Object.create(proto)
  const chat = model({ sessionId: '', messages: [], proposals: [], files: [], defaults: { packageId: '', timer: '', authNote: '' }, draft: null, turn: null, starting: false, input: '' })
  Object.assign(ctl, {
    chat: () => chat,
    formatter: { usageLine: () => '', tokens: (n) => String(n) },
    byId: () => ({ focus() {}, close() {}, getDomRef: () => null }),
    getRouter: () => ({ navTo: jest.fn() }),
    stopTurnPolling: jest.fn(),
    startTurnPolling: jest.fn(),
    setActive: jest.fn(),
    loadAttachments: jest.fn(),
    loadSessions: jest.fn(),
    loadPackages: jest.fn(),
    scrollChat: jest.fn(),
    toast: jest.fn(),
    showError: jest.fn()
  })
  return { ctl, chat, api }
}

/** Answers the four requests loadSession makes for `id` */
function answerSession(api, id, { running = false } = {}) {
  const pending = api.calls.filter((c) => c.url.includes(id) && !c.done)
  for (const c of pending) {
    c.done = true
    if (c.url.startsWith(`/ChatSessions/${id}/messages`)) c.resolve([{ role: 'user', content: `question in ${id}` }])
    else if (c.url.startsWith(`/ChatSessions/${id}`)) c.resolve({ ID: id, defaults: null, draftSpec: null })
    else if (c.url.startsWith('/Proposals')) c.resolve([])
    else if (c.url.startsWith('/ChatTurns')) c.resolve(running ? [{ ID: `turn-${id}`, createdAt: new Date().toISOString(), message: `running in ${id}`, events: [] }] : [])
  }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('Generate page: switching conversations while requests are in flight', () => {
  test('a slow load of conversation A does not overwrite B, opened meanwhile', async () => {
    const { ctl, chat, api } = controller()
    chat.setProperty('/sessionId', 'A')
    const loadA = ctl.loadSession('A')
    chat.setProperty('/sessionId', 'B')
    const loadB = ctl.loadSession('B')
    answerSession(api, 'B')
    await loadB
    answerSession(api, 'A', { running: true }) // A answers last, with a running turn
    await loadA
    await flush()
    expect(chat.getProperty('/messages').map((m) => m.text)).toEqual(['question in B'])
    expect(ctl.startTurnPolling).not.toHaveBeenCalled() // A's turn is not polled under B
    expect(chat.getProperty('/loadingSession')).toBe(false)
  })

  test('a message sent from A whose answer arrives after switching to B does not poll under B', async () => {
    const { ctl, chat, api } = controller()
    chat.setProperty('/sessionId', 'A')
    const sending = ctl.send('Hello')
    await flush()
    chat.setProperty('/sessionId', 'B')
    const loadB = ctl.loadSession('B')
    answerSession(api, 'B')
    await loadB
    api.calls.find((c) => c.url === '/chat').resolve({ turnId: 'turn-1', sessionId: 'A', status: 'RUNNING' })
    await sending
    expect(ctl.startTurnPolling).not.toHaveBeenCalled()
    expect(ctl.toast).toHaveBeenCalledWith('Message sent. Open its conversation from the history to see the answer.')
  })

  test('the navigation after creating a conversation is skipped once, not forever', () => {
    const { ctl, chat } = controller()
    const route = (session) => ({ getParameter: () => ({ '?query': session ? { session } : {} }) })
    ctl.loadSession = jest.fn()
    ctl._skipLoad = 'X'
    ctl.onRoute(route('X')) // the navTo right after the first send: skipped
    expect(ctl.loadSession).not.toHaveBeenCalled()
    ctl.onRoute({ getParameter: () => ({ '?query': { resume: '1' } }) }) // the side nav: back to the last conversation (a redirect, no load here)
    ctl.onRoute(route('X')) // browser Back to X: loaded, not skipped again
    expect(ctl.loadSession).toHaveBeenLastCalledWith('X')
    expect(chat.getProperty('/sessionId')).toBe('X')
  })
})

describe('Generate page: approve runs once at a time', () => {
  function setup(proposal) {
    const { ctl, chat, api } = controller()
    chat.setProperty('/packages', [{ id: 'P', name: 'P' }])
    chat.setProperty('/active', { isIflow: true, isUpdate: false })
    Object.assign(ctl, {
      currentProposal: () => proposal,
      confirm: jest.fn(async () => true),
      updateProposal: jest.fn(),
      startProposalPolling: jest.fn(),
      fetchProposal: jest.fn()
    })
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    }
    return { ctl, chat, api, flush }
  }
  const pending = { ID: 'p1', status: 'PENDING', iflowId: 'A', packageId: 'P' }

  test('a second Approve while the first runs sends nothing; the buttons are enabled again afterwards', async () => {
    const s = setup(pending)
    const first = s.ctl.onApprove()
    await s.flush()
    expect(s.chat.getProperty('/writing')).toBe(true)
    await s.ctl.onApproveDeploy()
    expect(s.ctl.confirm).toHaveBeenCalledTimes(1)
    expect(s.api.post).toHaveBeenCalledTimes(1)
    s.api.calls.find((c) => c.url.endsWith('/approve')).resolve({ ID: 'p1', status: 'APPROVED' })
    await first
    expect(s.chat.getProperty('/writing')).toBe(false)
  })
})

describe('Generate page: coming back keeps the conversation, its unsent text and files', () => {
  function setup() {
    const { ctl, chat, api } = controller()
    const navTo = jest.fn()
    ctl.getRouter = () => ({ navTo })
    const route = (query) => ctl.onRoute({ getParameter: () => ({ '?query': query }) })
    return { ctl, chat, api, navTo, route }
  }

  async function openA(s) {
    s.route({ session: 'A' })
    answerSession(s.api, 'A')
    await flush()
    s.chat.setProperty('/input', 'Use the attached script')
    s.chat.setProperty('/files', [{ fileName: 'mapOrders.groovy', pending: true, content: 'x' }])
  }

  test('the menu (#/generate) returns to the conversation open last', async () => {
    const s = setup()
    await openA(s)
    s.route({ resume: '1' }) // left menu → Generate
    expect(s.navTo).toHaveBeenCalledWith('generate', { '?query': { session: 'A' } }, true)
  })

  test('back in the same conversation: the unsent file and the typed text are still there', async () => {
    const s = setup()
    await openA(s)
    s.route({ session: 'A' }) // e.g. back from Monitor
    answerSession(s.api, 'A')
    await flush()
    expect(s.chat.getProperty('/files')).toEqual([{ fileName: 'mapOrders.groovy', pending: true, content: 'x' }])
    expect(s.chat.getProperty('/input')).toBe('Use the attached script')
  })

  test('another conversation: the unsent file and text of A are dropped', async () => {
    const s = setup()
    await openA(s)
    s.route({ session: 'B' })
    answerSession(s.api, 'B')
    await flush()
    expect(s.chat.getProperty('/files')).toEqual([])
    expect(s.chat.getProperty('/input')).toBe('')
  })

  test('"New conversation" (?new=1) opens an empty one, and the menu then stays on it', async () => {
    const s = setup()
    await openA(s)
    s.ctl.onNewChat()
    expect(s.navTo).toHaveBeenLastCalledWith('generate', { '?query': { new: '1' } })
    s.route({ new: '1' })
    expect(s.chat.getProperty('/messages')).toEqual([])
    expect(s.chat.getProperty('/files')).toEqual([])
    s.navTo.mockClear()
    s.route({ resume: '1' }) // left menu → Generate: the new (empty) conversation, not A
    expect(s.navTo).toHaveBeenCalledWith('generate', { '?query': { new: '1' } }, true)
  })

  test('a last conversation that cannot be loaded (e.g. deleted) is not reopened by the menu', async () => {
    const s = setup()
    s.route({ session: 'Gone' })
    for (const c of s.api.calls.filter((x) => x.url.includes('Gone'))) {
      c.resolve(c.url === '/ChatSessions/Gone' ? Promise.reject(new Error('not found')) : [])
    }
    await flush()
    s.navTo.mockClear()
    s.route({ resume: '1' })
    expect(s.navTo).toHaveBeenCalledWith('generate', { '?query': { new: '1' } }, true)
  })

  test('a conversation that cannot be loaded does not leave the previous one on screen (review)', async () => {
    const s = setup()
    await openA(s)
    s.chat.setProperty('/proposals', [{ ID: 'pA' }])
    s.route({ session: 'Gone' })
    for (const c of s.api.calls.filter((x) => x.url.includes('Gone'))) c.resolve(c.url === '/ChatSessions/Gone' ? Promise.reject(new Error('not found')) : [])
    await flush()
    expect(s.ctl.showError).toHaveBeenCalled()
    expect(s.chat.getProperty('/messages')).toEqual([])
    expect(s.chat.getProperty('/proposals')).toEqual([])
    expect(s.chat.getProperty('/sessionId')).toBe('') // sending starts a new conversation
    expect(s.ctl.setActive).toHaveBeenLastCalledWith(null)
  })

  test('a plain #/generate (e.g. a history entry) shows it as it is: no redirect that would catch browser Back', async () => {
    const s = setup()
    await openA(s)
    s.navTo.mockClear()
    s.route({})
    expect(s.navTo).not.toHaveBeenCalled()
  })
})

describe('Generate page: import', () => {
  test('import into a new conversation keeps the suggested prompt (routing runs later and must not clear it)', async () => {
    const { ctl, chat, api } = controller()
    const navTo = jest.fn()
    ctl.getRouter = () => ({ navTo })
    ctl.currentDefaults = () => ({})
    global.FileReader = function () {
      this.readAsDataURL = () => {
        this.result = 'data:application/zip;base64,UEsDBA=='
        this.onload()
      }
    }
    try {
      chat.setProperty('/sessionId', '')
      const importing = ctl.onImport({ getParameter: () => [{ name: 'flow.zip', size: 10 }], getSource: () => ({ clear() {} }) })
      await flush()
      api.calls.find((c) => c.url === '/importIflow').resolve({ sessionId: 'NEW', spec: { id: 'Flow' }, placeholders: 0 })
      await flush()
      answerSession(api, 'NEW')
      await importing
      // the route fires afterwards (asynchronous routing)
      ctl.onRoute({ getParameter: () => ({ '?query': { session: 'NEW' } }) })
      await flush()
      expect(navTo).toHaveBeenCalledWith('generate', { '?query': { session: 'NEW' } })
      expect(chat.getProperty('/sessionId')).toBe('NEW')
      expect(chat.getProperty('/input')).toBe('Propose the imported iFlow as a new iFlow.')
    } finally {
      delete global.FileReader
    }
  })
})

describe('Generate page: conversation list shows when a conversation is deleted for inactivity', () => {
  test('days left from the last activity; kept ones say so; no hint when the cleanup is off', () => {
    const { ctl } = controller()
    ctl.formatter = { relativeTime: () => '2 days ago' }
    const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()
    ctl._retentionDays = 14
    expect(ctl.sessionInfo({ modifiedAt: daysAgo(2), keep: false })).toBe('2 days ago · deleted in 12 days')
    expect(ctl.sessionInfo({ modifiedAt: daysAgo(13.5), keep: false })).toBe('2 days ago · deleted within a day')
    expect(ctl.sessionInfo({ modifiedAt: daysAgo(30), keep: true })).toBe('2 days ago · kept')
    ctl._retentionDays = 0
    expect(ctl.sessionInfo({ modifiedAt: daysAgo(2), keep: false })).toBe('2 days ago')
  })
})

describe('proposal panel for routers (phase 1b)', () => {
  /** The controller with a stub flow diagram, showing one proposal; returns chat>/active */
  function activeFor(spec) {
    const promptLint = factoryOf(path.join(WEBAPP, 'util/promptLint.js'))()
    const markdown = factoryOf(path.join(WEBAPP, 'util/markdown.js'))()
    const flowDiagram = { toHtml: () => '', fromSpec: () => ({}) }
    const proto = factoryOf(path.join(WEBAPP, 'controller/Generate.controller.js'))({ extend: (_n, p) => p }, function () {}, null, null, null, null, null, null, {}, markdown, flowDiagram, promptLint)
    const ctl = Object.create(proto)
    const proposal = { ID: 'p1', kind: 'IFLOW', status: 'PENDING', iflowId: spec.id, packageId: 'P', spec, createdAt: new Date().toISOString() }
    const chat = model({ proposals: [proposal], activeId: 'p1', packages: [], files: [] })
    Object.assign(ctl, { chat: () => chat, formatter: { relativeTime: () => 'now' } })
    ctl.refreshActive()
    return chat.getProperty('/active')
  }
  const cm = (name) => ({ type: 'contentModifier', name, properties: [{ name: 'p', type: 'constant', value: '1' }] })
  const xmlRouter = { type: 'router', name: 'RT_Type', expressionType: 'XML', routes: [{ name: 'X', condition: "/a = 'x'" }, { name: 'Other', default: true }] }
  const base = (steps, extra = {}) => ({ id: 'F', name: 'F', trigger: { type: 'timer', mode: 'once' }, steps, end: { type: 'none' }, ...extra })

  test('splitters, gathers, process calls and local processes (phase 2): plain words, per-item steps, callers, the gather note', () => {
    const lp = { name: 'LIP_Handle', steps: [cm('H1'), { type: 'groovyScript', name: 'H2', fileName: 'handle', code: 'x' }] }
    const active = activeFor(
      base(
        [
          cm('A'),
          { type: 'splitter', name: 'SPL', kind: 'general', expression: '/orders/order', stopOnException: false },
          { type: 'processCall', name: 'PC', process: 'LIP_Handle' },
          cm('B'),
          { type: 'gather', name: 'GA', source: '//order', target: '/orders' },
          { type: 'processCall', name: 'LPC', process: 'LIP_Handle', loop: { condition: "${property.more} = 'true'", max: 5 } },
          { type: 'splitter', name: 'SPL2', kind: 'iterating', expression: '//x', stopOnException: true }
        ],
        { localProcesses: [lp, { name: 'LIP_Unused', steps: [cm('U1')] }] }
      )
    )
    const card = (title) => active.stepCards.find((c) => c.title === title)
    expect(card('2. SPL')).toMatchObject({ type: 'General Splitter', lines: 'XPath /orders/order\nOne failing item does not stop the rest\nSteps 3–4 run once per item; GA (step 5) combines the items again' })
    expect(card('7. SPL2')).toMatchObject({ type: 'Iterating Splitter', lines: 'XPath //x\nOne failing item stops the rest\nNo step runs per item, up to the end' })
    expect(card('5. GA')).toMatchObject({ type: 'Gather', lines: 'Combines the items: //order into /orders (XML, same format)' })
    expect(activeFor(base([{ type: 'splitter', name: 'S', kind: 'iterating', expression: '//a', stopOnException: false }, { type: 'gather', name: 'GC' }])).stepCards.find((c) => c.title === '2. GC').lines).toBe('Combines the items (XML, same format)')
    expect(card('6. LPC')).toMatchObject({ type: 'Looping Process Call', lines: "Calls local process LIP_Handle\nAgain while ${property.more} = 'true', at most 5 times" })
    expect(card('LIP_Handle')).toMatchObject({ type: 'Local Process', lines: 'Called by PC, LPC' })
    expect(card('LIP_Unused')).toMatchObject({ lines: 'No step calls it, so it never runs' })
    expect(card('L1.2 H2')).toMatchObject({ type: 'Groovy Script' })
    expect(active.gatherText).toBe('Exchange properties set while processing one item do not reach the steps after GA: results must travel in the message body.')
    expect(active.scripts.map((x) => x.fileName)).toEqual(['handle.groovy']) // scripts of local processes are listed too
    expect(activeFor(base([cm('A')])).gatherText).toBe('')
    // Combine: the envelope note, with "may" until a deployed run confirms it; not after Combine at XPath
    expect(active.combineText).toBe('')
    const combine = activeFor(base([{ type: 'splitter', name: 'S', kind: 'iterating', expression: '//a', stopOnException: false }, { type: 'gather', name: 'GC' }]))
    expect(combine.combineText).toMatch(/^After GC \(Combine\), CPI may wrap the combined items in a multi-mapping envelope \(multimap:Messages \/ multimap:Message1\) instead of the original root\. An XPath like \/orders\/order may then find nothing; \/\/order works/)
  })

  test('the SOAP sender card (phase 5): address, Manual, Request-Reply, XML in and out, the role for callers', () => {
    const active = activeFor({ ...base([{ type: 'contentModifier', name: 'A', properties: [{ name: 'p', type: 'constant', value: 'x' }] }]), trigger: { type: 'soapSender', address: '/orders/soap' } })
    expect(active.stepCards[0]).toEqual({
      title: 'Trigger',
      type: 'SOAP sender',
      lines:
        'SOAP 1.x sender at /orders/soap. Service definition Manual (no WSDL), Request-Reply: the message body at the end of the flow is the response. XML in and out.\nCallers need the role ESBMessaging.send, for example through a service key of a Process Integration Runtime instance with plan integration-flow.'
    })
    // the HTTPS sender card carries the same note; a timer has none
    expect(activeFor({ ...base([{ type: 'contentModifier', name: 'A', properties: [{ name: 'p', type: 'constant', value: 'x' }] }]), trigger: { type: 'httpsSender', address: '/orders' } }).stepCards[0]).toEqual({
      title: 'Trigger',
      type: 'HTTPS sender',
      lines: '/orders\nCallers need the role ESBMessaging.send, for example through a service key of a Process Integration Runtime instance with plan integration-flow.'
    })
    expect(activeFor(base([{ type: 'contentModifier', name: 'A', properties: [{ name: 'p', type: 'constant', value: 'x' }] }])).stepCards[0].lines).toBe('Runs once after deployment')
  })

  test('a placeholder step: the panel says to replace it before deploying and to approve without deploy', () => {
    const ph = (name) => ({ type: 'contentModifier', name, description: `REPLACE WITH ${name}`, properties: [{ name: 'REPLACE_WITH', type: 'constant', value: name }] })
    expect(activeFor(base([ph('PH_CallOrders')])).placeholderText).toBe('PH_CallOrders: a placeholder step. Replace it in the CPI editor before deploying. Approve without deploy.')
    expect(activeFor(base([ph('PH_A')], { exceptionSubprocess: { steps: [ph('PH_B')], end: { event: 'escalation' } } })).placeholderText).toBe('PH_A, PH_B: placeholder steps. Replace them in the CPI editor before deploying. Approve without deploy.')
    expect(activeFor(base([{ type: 'contentModifier', name: 'A', properties: [{ name: 'p', type: 'constant', value: 'x' }] }])).placeholderText).toBe('')
  })

  test('the panel and srv/iflow-builder/placeholders.js agree on which steps are placeholders', () => {
    const { placeholderNames } = require('../srv/iflow-builder/placeholders')
    const cm = (name, description, extra = {}) => ({ type: 'contentModifier', name, ...(description != null && { description }), properties: [{ name: 'p', type: 'constant', value: 'x' }], ...extra })
    const examples = [
      base([cm('PH_A', 'REPLACE WITH Request Reply to /a')]),
      base([cm('A', 'replace with lower case')]), // not a placeholder: the prefix is upper case
      base([cm('A', 'REPLACE WITHOUT a note')]), // not one: REPLACE WITH must be a whole word
      base([cm('A', ' REPLACE WITH leading space')]), // not one: the description must start with it
      base([cm('A', 'Calls REPLACE WITH later')]),
      base([cm('A')]),
      base([{ type: 'groovyScript', name: 'G', description: 'REPLACE WITH a script', fileName: 'g' }]), // only Content Modifiers
      base([cm('PH_B', 'REPLACE WITH')]), // a placeholder without a note (the validator refuses it)
      base([{ type: 'router', name: 'RT', expressionType: 'NonXML', routes: [{ name: 'R', condition: "${property.a} = '1'", steps: [cm('PH_Route', 'REPLACE WITH x')] }, { name: 'D', default: true }] }]),
      base([{ type: 'multicast', name: 'MC', mode: 'parallel', branches: [{ steps: [cm('PH_Branch', 'REPLACE WITH x')] }, { steps: [cm('B')] }] }, { type: 'gather', name: 'GA' }]),
      base([{ type: 'processCall', name: 'PC', process: 'L' }], { localProcesses: [{ name: 'L', steps: [cm('PH_Local', 'REPLACE WITH x')] }] }),
      base([cm('A')], { exceptionSubprocess: { steps: [cm('PH_Error', 'REPLACE WITH x')], end: { event: 'escalation' } } })
    ]
    const panelNames = (spec) => {
      const text = activeFor(spec).placeholderText
      return text ? text.split(': ')[0].split(', ') : []
    }
    for (const spec of examples) expect(panelNames(spec)).toEqual(placeholderNames(spec))
    expect(examples.map((spec) => placeholderNames(spec).length)).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1])
  })

  test('the ProcessDirect sender card (phase 5): no role, headers rather than properties, a unique address', () => {
    const active = activeFor({ ...base([{ type: 'contentModifier', name: 'A', properties: [{ name: 'p', type: 'constant', value: 'x' }] }]), trigger: { type: 'processDirectSender', address: '/orders/process' } })
    expect(active.stepCards[0]).toEqual({
      title: 'Trigger',
      type: 'ProcessDirect sender',
      lines:
        'ProcessDirect sender at /orders/process. Called by other iFlows on the same tenant with this address; no authentication, not reachable from outside the tenant. A caller that waits for the reply gets the message body at the end of the flow.\nHeaders and the body reach this iFlow, but exchange properties may not: the caller passes values as headers.\nThe address must be unique among the ProcessDirect senders on the tenant; a second iFlow with the same address may fail to deploy.'
    })
  })

  test('SOAP and Mail cards (phase 3): no-WSDL warning in plain words, fixed mail settings shown, credentials in the note', () => {
    const soap = { type: 'requestReplySoap', name: 'RR', system: 'SysS', url: 'http://s4dummy/x', authType: 'Basic', credentialName: 'S_CRED', proxyType: 'On-Premise', locationId: 'LOC' }
    const mail = { type: 'sendMail', name: 'SND', system: 'SysM', server: 'smtp.example.com:587', credentialName: 'M_CRED', from: 'a@example.com', to: 'b@example.com', cc: 'c@example.com', subject: 'Hi' }
    const active = activeFor(base([soap, mail], { exceptionSubprocess: { steps: [{ ...mail, name: 'Alert', system: 'SysA', credentialName: 'A_CRED' }], end: { event: 'escalation' } } }))
    const card = (title) => active.stepCards.find((c) => c.title === title)
    expect(card('1. RR')).toMatchObject({ type: 'Request Reply (SOAP)', lines: 'SOAP 1.x http://s4dummy/x\nBasic, credential S_CRED · On-Premise, location LOC\nNo WSDL: the message body is sent as it is, so it must be the XML the service expects' })
    expect(card('2. SND')).toMatchObject({
      type: 'Send (Mail)',
      lines: 'To b@example.com, cc c@example.com, from a@example.com\nSubject: Hi\nBody: ${in.body} (the message body)\nsmtp.example.com:587 · STARTTLS mandatory · Plain User/Password, credential M_CRED · text/plain\nOne-way: the flow continues after it'
    })
    expect(card('E1. Alert')).toMatchObject({ type: 'Send (Mail)' })
    expect(active.receiversText).toBe('Before deploying, the credentials must exist as security material on the tenant: S_CRED (Basic, SysS), M_CRED (Plain User/Password, SysM), A_CRED (Plain User/Password, SysA).')
  })

  test('tenant check of phase 3: the XML notes name the step before: SOAP after a Content Modifier, an XML router after a mail', () => {
    const soap = (name) => ({ type: 'requestReplySoap', name, url: 'http://s4dummy/x', authType: 'Basic', credentialName: 'C', proxyType: 'On-Premise' })
    const mail = { type: 'sendMail', name: 'SND_Done', server: 'h:25', credentialName: 'C', from: 'a@example.com', to: 'b@example.com', subject: 'S' }
    const active = activeFor(base([cm('CM_SetBody'), soap('RR_Soap'), mail, xmlRouter]))
    expect(active.xmlSoapText).toMatch(/^The body of a SOAP call must be XML\. CPI may show the notice "may not pass XML message to Soap1x Receiver\. Soap1x Receiver supports XML input only" on the SOAP line of RR_Soap \(after CM_SetBody\)/)
    expect(active.xmlRouterText).toMatch(/on the routes of RT_Type \(after SND_Done\)/)
    // known XML: no note; in a route: the step before its router, then the step before it in the route; in a local process
    expect(activeFor(base([{ type: 'jsonToXml', name: 'ToXml' }, soap('S')])).xmlSoapText).toBe('')
    const routed = { ...xmlRouter, routes: [{ name: 'X', condition: "/a = 'x'", steps: [soap('S1'), cm('Mid'), soap('S2')] }, { name: 'Other', default: true }] }
    expect(activeFor(base([{ type: 'jsonToXml', name: 'ToXml' }, routed])).xmlSoapText).toMatch(/on the SOAP line of S2 \(after Mid\):/)
    const local = activeFor(base([{ type: 'processCall', name: 'PC', process: 'L' }], { localProcesses: [{ name: 'L', steps: [soap('S3')] }] }))
    expect(local.xmlSoapText).toMatch(/S3 \(first step\)/)
    expect(activeFor(base([cm('A')])).xmlSoapText).toBe('')
  })

  test('mapping cards and the XML note (phase 4): the artifact must exist and be deployed', () => {
    const active = activeFor(base([cm('CM_SetBody'), { type: 'messageMapping', name: 'MM', mapping: 'MM_Art' }, { type: 'xsltMapping', name: 'XS', file: 't.xsl' }, { type: 'messageMapping', name: 'IN', file: 'X.mmap', schemas: ['a.xsd'] }]))
    const card = (title) => active.stepCards.find((c) => c.title === title)
    expect(card('2. MM')).toMatchObject({ type: 'Message Mapping', lines: 'Refers to the artifact MM_Art: it must exist on the tenant and be deployed before the iFlow can run' })
    expect(card('3. XS')).toMatchObject({ type: 'XSLT Mapping', lines: 'mapping/t.xsl (attached file)' })
    expect(card('4. IN')).toMatchObject({ lines: 'Mapping inside the iFlow: X.mmap, with a.xsd' })
    expect(active.xmlMappingText).toMatch(/^A Message Mapping takes XML or JSON\. CPI may show a notice about XML or JSON input on MM \(after CM_SetBody\), IN \(after XS\): .* make sure the body is XML or JSON at that point\. An XSLT Mapping takes XML\. CPI may show a notice about XML input on XS \(after MM\): /)
    expect(activeFor(base([{ type: 'jsonToXml', name: 'J' }, { type: 'messageMapping', name: 'MM', mapping: 'A' }])).xmlMappingText).toBe('')
  })

  test('multicast cards (phase 9): the branches, their steps numbered by branch, the gather and the notes', () => {
    const inBranch = { type: 'router', name: 'RT', expressionType: 'XML', routes: [{ name: 'R', condition: '/a = 1', steps: [cm('Y')], end: {} }, { name: 'D', default: true }] }
    const active = activeFor(base([cm('CM_SetBody'), { type: 'multicast', name: 'MC', mode: 'sequential', join: 'JN', branches: [{ steps: [cm('A')] }, { name: 'Other', steps: [inBranch, { type: 'messageMapping', name: 'MM', mapping: 'X' }] }] }, { type: 'gather', name: 'GA' }]))
    const card = (title) => active.stepCards.find((c) => c.title === title)
    expect(card('2. MC')).toMatchObject({ type: 'Sequential Multicast', lines: 'Branch 1: 1 step\nOther: 2 steps\nThe branches run one after the other, in this order; they meet at JN' })
    expect(card('2.B1.1 A')).toMatchObject({ type: 'Content Modifier · Branch 1' })
    expect(card('2.B2.1.1.1 Y')).toMatchObject({ type: 'Content Modifier · Other, route R' })
    expect(card('3. GA')).toMatchObject({ lines: 'Combines the branches after JN (XML, same format)' })
    expect(active.xmlRouterText).toMatch(/on the routes of RT \(after MC\)/)
    expect(active.xmlMappingText).toMatch(/input on MM \(after RT\)|input on MM \(after MC\)/)
    expect(active.gatherText).toMatch(/^Exchange properties set in a multicast branch may not reach the other branches/)
    expect(active.combineText).toMatch(/^After GA \(Combine\)/)
  })

  test('an XML router after a Content Modifier (routers in between skipped) gets the XML input notice', () => {
    const nonXml = { type: 'router', name: 'RT_Check', expressionType: 'NonXML', routes: [{ name: 'A', condition: '${a} = 1' }, { name: 'D', default: true }] }
    expect(activeFor(base([cm('CM_SetInput'), nonXml, xmlRouter])).xmlRouterText).toMatch(/on the routes of RT_Type \(after CM_SetInput\): it cannot tell/)
    expect(activeFor(base([{ type: 'jsonToXml', name: 'ToXml' }, xmlRouter])).xmlRouterText).toBe('')
    expect(activeFor(base([cm('A'), nonXml])).xmlRouterText).toBe('')
    // phase 2 tenant check: CPI shows the notice after a splitter too; only a JSON to XML converter is known to produce XML
    const split = { type: 'splitter', name: 'SPL', kind: 'iterating', expression: '//a', stopOnException: false }
    expect(activeFor(base([split, xmlRouter])).xmlRouterText).toMatch(/on the routes of RT_Type \(after SPL\): it cannot tell that the step before produces XML/)
    expect(activeFor(base([xmlRouter])).xmlRouterText).toMatch(/RT_Type \(first step\)/)
    // routers in local processes too, with their route steps numbered L1.2.1.1
    const lp = { name: 'L', steps: [cm('L1'), { ...xmlRouter, name: 'LR', routes: [{ name: 'X', condition: "/a = 'x'", steps: [cm('InLocalRoute')] }, { name: 'Other', default: true }] }] }
    const active = activeFor(base([{ type: 'processCall', name: 'PC', process: 'L' }], { localProcesses: [lp] }))
    expect(active.xmlRouterText).toMatch(/on the routes of LR \(after L1\)/)
    expect(active.stepCards.find((c) => c.title === 'L1.2.1.1 InLocalRoute')).toMatchObject({ type: 'Content Modifier · route X' })
    expect(active.xmlRouterText).toMatch(/^CPI may show the notice/) // the tenant check showed none after a step that sets no body
    // a route End in a local process returns to the caller (the main flow goes on after the process call)
    const ending = { ...lp, steps: [{ ...xmlRouter, name: 'LR', routes: [{ name: 'X', condition: "/a = 'x'", end: { event: 'message' } }, { name: 'Other', default: true }] }] }
    expect(activeFor(base([{ type: 'processCall', name: 'PC', process: 'L' }], { localProcesses: [ending] })).stepCards.find((c) => c.title === 'L1.1 LR').lines).toBe(
      "X: /a = 'x' → End (returns to the caller)\nOther: default → continues"
    )
  })

  test('route steps are numbered under their router; End and error handling show their end events (Escalation End with its category)', () => {
    const routes = [
      { name: 'X', condition: "/a = 'x'", steps: [cm('InRoute')] },
      { name: 'Y', condition: "/a = 'y'", end: { event: 'escalation', category: 'RoutingConditionNotMet' } },
      { name: 'Other', default: true }
    ]
    const active = activeFor(base([cm('A'), { ...xmlRouter, routes }], { exceptionSubprocess: { steps: [cm('E')], end: { event: 'escalation' } } }))
    const cards = active.stepCards.map((c) => [c.title, c.type])
    expect(cards).toEqual(
      expect.arrayContaining([
        ['2. RT_Type', 'Router'],
        ['2.1.1 InRoute', 'Content Modifier · route X'],
        ['End', 'Message End']
      ])
    )
    expect(active.stepCards.find((c) => c.type === 'Router').lines).toMatch(/Y: \/a = 'y' → Escalation End \(Routing condition not met\)/)
    // no category: the default "Others - not further qualified"
    expect(active.stepCards.find((c) => c.type === 'Exception Subprocess').lines).toMatch(
      /ends with an Escalation End \(Others - not further qualified\): the message is shown as escalated/
    )
  })
})
