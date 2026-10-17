/**
 * Agent: OpenAI-style function calling, max 8 model calls per user message.
 *
 * Chat is asynchronous: startTurn() stores a ChatTurn (RUNNING) and returns at once;
 * the loop runs in the background and appends progress events to the turn
 * ("Thinking…", "Calling listPackages", "Validating spec", "Proposal ready"). Clients
 * poll the turn; cancelTurn() stops it between steps and aborts the model call in flight.
 *
 * Messages are buffered per turn and written at the end, so history never contains
 * half-finished tool exchanges. A failed/cancelled turn keeps the user message plus
 * an assistant note.
 */
const fs = require('fs')
const path = require('path')
const cds = require('@sap/cds')
const llm = require('../lib/llm')
const tools = require('./tools')

const LOG = cds.log('agent')
const MAX_ITERATIONS = 8
const HISTORY_LIMIT = 40 // messages sent back to the model
const INTERRUPTED = 'Interrupted by server restart — please send your message again.'
const PACKAGE_ID = /^[A-Za-z0-9.]+$/
const MAX_AUTH_NOTE = 500

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8')

const db = (user, fn) => cds.tx({ user }, fn)
const E = () => cds.entities('iflowpilot')
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

/** AbortControllers of turns running in this process */
const running = new Map()

// --- session defaults ----------------------------------------------------------------

/**
 * Session defaults from the chat panel, checked and trimmed; undefined if none were sent
 * (the stored ones stay), {} to clear them.
 */
function normalizeDefaults(d) {
  if (d == null) return undefined
  const out = {}
  const packageId = String(d.packageId ?? '').trim()
  const timer = String(d.timer ?? '').trim()
  const authNote = String(d.authNote ?? '').trim()
  if (packageId) {
    if (!PACKAGE_ID.test(packageId)) throw fail(400, 'INVALID_DEFAULTS', 'Default package id: use letters, digits and dots only (CPI does not allow underscores)')
    out.packageId = packageId
  }
  if (timer) {
    if (timer !== 'once') throw fail(400, 'INVALID_DEFAULTS', `Default timer '${timer}' is not supported; v1 only runs once after deployment ('once')`)
    out.timer = timer
  }
  if (authNote) {
    if (authNote.length > MAX_AUTH_NOTE) throw fail(400, 'INVALID_DEFAULTS', `Default authentication note: at most ${MAX_AUTH_NOTE} characters`)
    out.authNote = authNote
  }
  return out
}

/** Session defaults as structured context for the model, '' without defaults */
function defaultsContext(defaults) {
  if (!defaults || !Object.keys(defaults).length) return ''
  const structured = {
    ...(defaults.packageId && { packageId: defaults.packageId }),
    ...(defaults.timer && { trigger: { type: 'timer', mode: defaults.timer } }),
    ...(defaults.authNote && { receiverAuthentication: defaults.authNote })
  }
  const rules = [
    defaults.packageId && '- Use packageId as the spec\'s packageId.',
    defaults.timer && '- Use this trigger.',
    defaults.authNote &&
      '- Create every receiver with authType "None", and tell the user in your summary to set up this authentication in the CPI web editor after creation.'
  ].filter(Boolean)
  return `Session defaults (set by the user for this conversation; they override earlier messages; use them and never ask about them):\n${JSON.stringify(structured)}\n${rules.join('\n')}`
}

// --- persistence -------------------------------------------------------------------

async function ensureSession(user, sessionId, firstMessage) {
  const { ChatSession } = E()
  return db(user, async (tx) => {
    if (sessionId) {
      const s = await tx.run(SELECT.one.from(ChatSession, sessionId))
      if (!s) throw fail(404, 'SESSION_NOT_FOUND', `Chat session ${sessionId} not found`)
      return sessionId
    }
    const ID = cds.utils.uuid()
    const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 80)
    await tx.run(INSERT.into(ChatSession).entries({ ID, title }))
    return ID
  })
}

/** Stored messages -> OpenAI format, starting at a user message (no orphaned tool results) */
async function loadHistory(user, sessionId) {
  const { ChatMessage } = E()
  const rows = await db(user, (tx) => tx.run(SELECT.from(ChatMessage).where({ session_ID: sessionId }).orderBy('seq desc').limit(HISTORY_LIMIT)))
  rows.reverse()
  while (rows.length && rows[0].role !== 'user') rows.shift()
  return rows.map((m) => {
    const extra = m.toolCalls ? JSON.parse(m.toolCalls) : null
    if (m.role === 'tool') return { role: 'tool', tool_call_id: extra?.tool_call_id, content: m.content || '' }
    if (m.role === 'assistant' && Array.isArray(extra)) return { role: 'assistant', content: m.content || null, tool_calls: extra }
    return { role: m.role, content: m.content || '' }
  })
}

async function saveMessages(user, sessionId, messages) {
  const { ChatMessage, ChatSession } = E()
  await db(user, async (tx) => {
    const last = await tx.run(SELECT.one.from(ChatMessage).columns('max(seq) as seq').where({ session_ID: sessionId }))
    let seq = last?.seq ?? 0
    await tx.run(
      INSERT.into(ChatMessage).entries(
        messages.map((m) => ({
          session_ID: sessionId,
          seq: ++seq,
          role: m.role,
          content: m.content ?? null,
          toolCalls: m.tool_calls ? JSON.stringify(m.tool_calls) : m.tool_call_id ? JSON.stringify({ tool_call_id: m.tool_call_id }) : null
        }))
      )
    )
    await tx.run(UPDATE(ChatSession, sessionId).set({ modifiedAt: new Date().toISOString() }))
  })
}

async function loadProposals(user, ids) {
  if (!ids.length) return []
  const { Proposal } = E()
  const rows = await db(user, (tx) => tx.run(SELECT.from(Proposal).where({ ID: { in: ids } }).orderBy('createdAt')))
  return rows.map(toProposalInfo)
}

function toProposalInfo(p) {
  return { ID: p.ID, kind: p.kind, operation: p.operation, status: p.status, iflowId: p.iflowId, packageId: p.packageId, spec: p.spec ? JSON.parse(p.spec) : null, createdAt: p.createdAt }
}

const STATUS_MEANING = {
  PENDING: 'waiting for the user to approve or reject',
  APPROVED: 'approved, being created on the tenant right now',
  DONE: 'approved and created on the tenant',
  REJECTED: 'rejected by the user',
  FAILED: 'approved, but creating it on the tenant failed'
}

/** System prompt + live context: date, session defaults and the status of this session's proposals */
async function systemMessage(user, sessionId) {
  const { Proposal, ChatSession } = E()
  const { proposals, session } = await db(user, async (tx) => ({
    proposals: await tx.run(SELECT.from(Proposal).where({ session_ID: sessionId }).orderBy('createdAt')),
    session: await tx.run(SELECT.one.from(ChatSession, sessionId).columns('defaults'))
  }))
  const lines = proposals.map((p) => {
    const result = p.result ? JSON.parse(p.result) : {}
    const detail = p.status === 'REJECTED' ? ` — reason: ${result.reason || 'none given'}` : p.status === 'FAILED' ? ` — error: ${p.error}` : ''
    return `- ${p.ID}: ${p.kind}${p.operation === 'UPDATE' ? ' UPDATE' : ''} ${p.iflowId || p.packageId} → ${p.status} (${STATUS_MEANING[p.status] || p.status})${detail}`
  })
  const context = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    lines.length
      ? `Proposals in this conversation (current status; it overrides anything said earlier in the conversation):\n${lines.join('\n')}`
      : 'No proposals in this conversation yet.',
    defaultsContext(session?.defaults ? JSON.parse(session.defaults) : null)
  ].filter(Boolean)
  return { role: 'system', content: `${SYSTEM_PROMPT}\n\n## Context\n${context.join('\n')}` }
}

// --- progress events ------------------------------------------------------------------

const event = (type, label, detail) => ({ at: new Date().toISOString(), type, label, ...(detail && { detail }) })

/** Human-readable progress label for a tool call */
function toolLabel(name, args) {
  if (name === 'proposeIflow' || name === 'proposeIflowUpdate' || name === 'validateSpec') return 'Validating spec'
  if (name === 'proposePackage') return 'Validating package proposal'
  const id = args?.iflowId || args?.packageId
  return `Calling ${name}${id ? ` (${id})` : ''}`
}

const parseArgs = (raw) => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw || {}
  } catch {
    return {}
  }
}

/** Drops a trailing assistant tool_calls message whose tool results are incomplete (no orphans in history) */
function completeExchanges(turn) {
  const i = turn.findLastIndex((m) => m.tool_calls)
  return i < 0 || turn.length - 1 - i === turn[i].tool_calls.length ? turn : turn.slice(0, i)
}

// --- turns -------------------------------------------------------------------------------

/**
 * Starts a turn and returns immediately; the agent runs in the background.
 * @returns {Promise<{ turnId: string, sessionId: string, status: 'RUNNING' }>}
 */
async function startTurn({ sessionId, message, defaults, user }) {
  if (!message || !String(message).trim()) throw fail(400, 'EMPTY_MESSAGE', 'Message is empty')
  const sessionDefaults = normalizeDefaults(defaults)
  sessionId = await ensureSession(user, sessionId, message)
  const { ChatTurn, ChatSession } = E()
  if (sessionDefaults)
    await db(user, (tx) => tx.run(UPDATE(ChatSession, sessionId).set({ defaults: Object.keys(sessionDefaults).length ? JSON.stringify(sessionDefaults) : null })))

  const turnId = cds.utils.uuid()
  await db(user, async (tx) => {
    // one turn at a time per session, so history stays in order
    const busy = await tx.run(SELECT.one.from(ChatTurn).columns('ID').where({ session_ID: sessionId, status: 'RUNNING' }))
    if (busy) throw fail(409, 'TURN_IN_PROGRESS', 'The assistant is still working on the previous message. Wait for it or cancel it.')
    await tx.run(INSERT.into(ChatTurn).entries({ ID: turnId, session_ID: sessionId, status: 'RUNNING', message: String(message), events: JSON.stringify([event('thinking', 'Thinking…')]) }))
  })

  const controller = new AbortController()
  running.set(turnId, controller)
  runTurn({ turnId, sessionId, message: String(message), user, signal: controller.signal })
    .catch((e) => LOG.error(`Turn ${turnId} crashed`, e))
    .finally(() => running.delete(turnId))
  return { turnId, sessionId, status: 'RUNNING' }
}

async function runTurn({ turnId, sessionId, message, user, signal }) {
  const { ChatTurn } = E()
  const ctx = { user, sessionId, proposals: [] }
  const events = [event('thinking', 'Thinking…')]
  const update = (patch = {}) => db(user, (tx) => tx.run(UPDATE(ChatTurn, turnId).set({ events: JSON.stringify(events), ...patch })))
  const emit = (type, label, detail) => {
    events.push(event(type, label, detail))
    return update()
  }
  // Cancel works across instances via the DB flag, and instantly in-process via the signal
  const checkCancel = async () => {
    if (signal.aborted) throw fail(499, 'CANCELLED', 'Cancelled')
    const t = await db(user, (tx) => tx.run(SELECT.one.from(ChatTurn).columns('cancelRequested').where({ ID: turnId })))
    if (t?.cancelRequested) throw fail(499, 'CANCELLED', 'Cancelled')
  }

  const turn = [{ role: 'user', content: message }]
  const finish = async (text, messages = turn) => {
    await saveMessages(user, sessionId, [...messages, { role: 'assistant', content: text }])
    const proposals = await loadProposals(user, ctx.proposals)
    events.push(event('done', 'Answer ready'))
    await update({ status: 'DONE', text, proposals: JSON.stringify(proposals) })
  }
  try {
    const history = await loadHistory(user, sessionId)
    const system = await systemMessage(user, sessionId)
    let text = null

    for (let i = 0; i < MAX_ITERATIONS && text === null; i++) {
      await checkCancel()
      if (i > 0) await emit('thinking', 'Thinking…')
      const res = await llm.chat({ messages: [system, ...history, ...turn], tools: tools.definitions, signal })
      const { message: msg, finish_reason: finish } = res.choices[0]
      if (res.fallbackUsed) await emit('info', `Answered by fallback model ${res.model}`)

      if (msg.tool_calls?.length) {
        const toolCalls = msg.tool_calls.map(({ id, type, function: f }) => ({ id, type, function: { name: f.name, arguments: f.arguments || '{}' } }))
        turn.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls })
        for (const tc of toolCalls) {
          await checkCancel()
          const name = tc.function.name
          const args = parseArgs(tc.function.arguments)
          await emit('tool', toolLabel(name, args))
          const content = await tools.execute(name, tc.function.arguments, ctx)
          turn.push({ role: 'tool', tool_call_id: tc.id, content })
          if (name === 'proposeIflow' || name === 'proposeIflowUpdate' || name === 'proposePackage') {
            const r = parseArgs(content)
            if (r.valid) await emit('proposal', name === 'proposeIflowUpdate' ? 'Update proposal ready' : 'Proposal ready', name === 'proposePackage' ? args.id : args.spec?.id)
            else await emit('validation', 'Spec has errors — revising', r.errors ? `${r.errors.length} error(s)` : r.error?.message)
          }
        }
        continue
      }

      text =
        msg.content ||
        (finish === 'length'
          ? 'My answer was cut off because it got too long. Please ask again, maybe in smaller parts.'
          : 'I could not produce an answer. Please rephrase your request.')
    }
    if (text === null) text = `I stopped after ${MAX_ITERATIONS} steps without finishing. Please tell me how to continue, or narrow down the request.`
    await finish(text)
  } catch (e) {
    const wasCancelled = e.code === 'CANCELLED'
    // A proposal was already stored and only a later step (usually the model's closing summary) failed:
    // the turn did its job, so end it DONE with a note instead of an error
    if (!wasCancelled && ctx.proposals.length) {
      LOG.warn(`Turn ${turnId}: proposal stored, then failed: ${e.code} ${e.message}`)
      const stored = await loadProposals(user, ctx.proposals).catch(() => [])
      const what = stored.map((p) => `${p.kind === 'PACKAGE' ? 'package' : 'iFlow'} ${p.iflowId || p.packageId}`).join(', ')
      const note = `The proposal${what ? ` (${what})` : ''} is ready for review in the proposal panel. (The AI model could not finish its summary: ${e.message})`
      const done = await finish(note, completeExchanges(turn)).then(() => true, (err) => LOG.error('Could not save turn', err))
      if (done) return
    }
    const note = wasCancelled ? 'Cancelled.' : `⚠️ ${e.message}`
    // Keep the conversation readable and consistent: user message + a note, no partial tool exchange
    await saveMessages(user, sessionId, [turn[0], { role: 'assistant', content: note }]).catch((err) => LOG.error('Could not save failed turn', err))
    const proposals = await loadProposals(user, ctx.proposals).catch(() => [])
    events.push(wasCancelled ? event('cancelled', 'Cancelled') : event('error', e.message))
    await update({
      status: wasCancelled ? 'CANCELLED' : 'FAILED',
      proposals: JSON.stringify(proposals),
      error: wasCancelled ? null : JSON.stringify({ code: e.code || 'AGENT_ERROR', message: e.message, hint: e.hint })
    }).catch((err) => LOG.error('Could not save turn status', err))
    if (!wasCancelled) LOG.warn(`Turn ${turnId} failed: ${e.code} ${e.message}`)
  }
}

/** Requests cancellation; the turn ends as CANCELLED at the next step (the model call is aborted at once) */
async function cancelTurn(turnId, user) {
  const { ChatTurn } = E()
  await db(user, async (tx) => {
    const t = await tx.run(SELECT.one.from(ChatTurn, turnId))
    if (!t) throw fail(404, 'TURN_NOT_FOUND', `Turn ${turnId} not found`)
    if (t.status !== 'RUNNING') throw fail(409, 'TURN_NOT_RUNNING', `Turn is ${t.status}; only running turns can be cancelled.`)
    await tx.run(UPDATE(ChatTurn, turnId).set({ cancelRequested: true }))
  })
  running.get(turnId)?.abort()
}

/**
 * Deletes a conversation: its messages, turns and PENDING proposals. Proposals that were
 * approved, rejected or executed are kept (history) and detached from the session.
 * Refused while a turn is running or a proposal is executing.
 */
async function deleteSession(sessionId, user) {
  const { ChatSession, ChatMessage, ChatTurn, Proposal } = E()
  await db(user, async (tx) => {
    if (!(await tx.run(SELECT.one.from(ChatSession, sessionId)))) throw fail(404, 'SESSION_NOT_FOUND', `Chat session ${sessionId} not found`)
    if (await tx.run(SELECT.one.from(ChatTurn).columns('ID').where({ session_ID: sessionId, status: 'RUNNING' })))
      throw fail(409, 'TURN_IN_PROGRESS', 'The assistant is still working in this conversation. Wait for it or cancel it, then delete.')
    if (await tx.run(SELECT.one.from(Proposal).columns('ID').where({ session_ID: sessionId, status: 'APPROVED' })))
      throw fail(409, 'PROPOSAL_EXECUTING', 'A proposal of this conversation is being executed. Delete the conversation when it has finished.')
    await tx.run(DELETE.from(Proposal).where({ session_ID: sessionId, status: 'PENDING' }))
    await tx.run(UPDATE(Proposal).set({ session_ID: null }).where({ session_ID: sessionId }))
    await tx.run(DELETE.from(ChatTurn).where({ session_ID: sessionId }))
    await tx.run(DELETE.from(ChatMessage).where({ session_ID: sessionId }))
    await tx.run(DELETE.from(ChatSession, sessionId))
  })
}

/** Called at startup: turns run in-process, so RUNNING turns were interrupted by a restart */
async function recoverInterruptedTurns() {
  const { ChatTurn } = E()
  const stuck = await db(undefined, (tx) => tx.run(SELECT.from(ChatTurn).where({ status: 'RUNNING' })))
  for (const t of stuck) {
    const events = t.events ? JSON.parse(t.events) : []
    events.push(event('error', INTERRUPTED))
    await saveMessages(undefined, t.session_ID, [{ role: 'user', content: t.message }, { role: 'assistant', content: `⚠️ ${INTERRUPTED}` }]).catch(() => {})
    await db(undefined, (tx) =>
      tx.run(UPDATE(ChatTurn, t.ID).set({ status: 'FAILED', events: JSON.stringify(events), error: JSON.stringify({ code: 'INTERRUPTED', message: INTERRUPTED }) }))
    )
    LOG.warn(`Chat turn ${t.ID} was interrupted by a restart; marked FAILED`)
  }
  return stuck.length
}

module.exports = { startTurn, cancelTurn, deleteSession, recoverInterruptedTurns, toProposalInfo, toolLabel, INTERRUPTED }
