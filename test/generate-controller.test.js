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

describe('Generate page: approve runs once at a time, and not with failed Groovy checks', () => {
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
  const pending = { ID: 'p1', status: 'PENDING', iflowId: 'A', packageId: 'P', scriptChecks: { 'a.groovy': { status: 'ok' } } }

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

  test('a failed Groovy check blocks approval; an unchecked script does not', () => {
    const s = setup(pending)
    expect(s.ctl.approvalBlocked({ scriptChecks: { 'a.groovy': { status: 'failed' }, 'b.groovy': { status: 'ok' } } })).toBe(true)
    expect(s.ctl.approvalBlocked({ scriptChecks: { 'a.groovy': { status: 'unchecked' } } })).toBe(false)
    expect(s.ctl.approvalBlocked({ scriptChecks: { 'a.groovy': { status: 'ok' } } })).toBe(false)
    expect(s.ctl.approvalBlocked({})).toBe(false)
  })

  test('Approve with a failed script does not ask or send', async () => {
    const s = setup({ ...pending, scriptChecks: { 'a.groovy': { status: 'failed' } } })
    await s.ctl.onApprove()
    expect(s.ctl.confirm).not.toHaveBeenCalled()
    expect(s.api.post).not.toHaveBeenCalled()
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
