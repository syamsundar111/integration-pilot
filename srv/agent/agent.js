/**
 * Agent: OpenAI-style function calling, up to AGENT_MAX_MODEL_CALLS (default 20) model calls per
 * user message: a large flow needs about 15 (scripts, the spec in parts, validation, proposal).
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
const attachmentStore = require('../lib/attachments')
const { importIflow } = require('../iflow-builder/import')
const tools = require('./tools')
const cpi = require('../lib/cpi-client')
const history = require('./history')

const LOG = cds.log('agent')
const maxIterations = () => Number(process.env.AGENT_MAX_MODEL_CALLS || 20)
const MIN_PROGRESS_TOKENS = 50 // the "~N tokens so far" line appears from this size on
const MAX_CUT_OFFS = 2 // answers cut off for length per message before the agent gives up
const tokenBudget = () => Number(process.env.AGENT_MAX_TOKENS_PER_MESSAGE || 300_000) // input + output tokens per user message
const CUT_OFF_NOTE =
  'Your previous response was cut off because it reached the output limit; nothing of it was used. Build the spec in parts instead: ' +
  'write each Groovy script with writeScript, then editDraftSpec with {"op":"set",...} and addSteps (at most 8 steps per call), then proposeIflow with { "useDraftSpec": true }.'
const HISTORY_LIMIT = 40 // earlier user messages and answers sent back to the model
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

const ORIGIN_NOTE = { iflow: ', from the existing iFlow', import: ', from the imported iFlow', ai: ', written by you with writeScript' }

/** Attached files as context: names, sizes and how to reference them — never their content */
function attachmentsContext(files) {
  if (!files.length) return ''
  const line = (f) =>
    f.kind === 'groovy'
      ? `- ${f.fileName} (Groovy, ${f.lines} lines${ORIGIN_NOTE[f.origin] || ''}): groovyScript step with "fileName": "${f.fileName.replace(/\.groovy$/, '')}" and no "code"`
      : `- ${f.fileName} (XSLT, ${f.lines} lines${ORIGIN_NOTE[f.origin] || ''}): list it in "resources"`
  return `Files of this conversation (stored on the server; reference them by name; change your own scripts with writeScript; never retype the others):\n${files.map(line).join('\n')}`
}

/** The latest spec as context: what it is and how to use it, never the spec itself */
function draftContext(draft) {
  if (!draft?.spec) return ''
  const { spec, source, valid } = draft
  const placeholders = [...(spec.steps || []), ...(spec.exceptionSubprocess?.steps || [])].filter((s) => /^REPLACE WITH /.test(s.description || '')).length
  return (
    `Draft spec of this conversation (${source}${valid ? ', valid' : ''}): ${spec.id} "${spec.name}", ${spec.steps?.length || 0} steps${placeholders ? `, ${placeholders} placeholder(s)` : ''}, package ${spec.packageId}. ` +
    'It is the latest spec of the conversation; earlier copies are not repeated in the history. ' +
    'Read it with getDraftSpec only if you need to change it; change it with editDraftSpec; propose it with { "useDraftSpec": true }.'
  )
}

/** Session defaults as structured context for the model, '' without defaults */
function defaultsContext(defaults, packageExists) {
  if (!defaults || !Object.keys(defaults).length) return ''
  const structured = {
    ...(defaults.packageId && { packageId: defaults.packageId }),
    ...(defaults.timer && { trigger: { type: 'timer', mode: defaults.timer } }),
    ...(defaults.authNote && { receiverAuthentication: defaults.authNote })
  }
  const rules = [
    defaults.packageId &&
      `- Use packageId as the spec's packageId. ${
        packageExists === true
          ? 'It exists on the tenant: do not call listPackages or listIflows to check it.'
          : packageExists === false
            ? 'It does not exist on the tenant yet; the proposal panel lets the user create it. Do not call listPackages to look for it.'
            : 'Whether it exists was not checked.'
      }`,
    defaults.timer && '- Use this trigger.',
    defaults.authNote &&
      '- Create every receiver with authType "None", and tell the user in your summary to set up this authentication in the CPI web editor after creation.'
  ].filter(Boolean)
  return `Session defaults (set by the user for this conversation; they override earlier messages; use them and never ask about them):\n${JSON.stringify(structured)}\n${rules.join('\n')}`
}

/** Whether a package exists on the tenant; undefined when CPI could not be asked */
async function packageExists(id) {
  try {
    await cpi.getPackage(id)
    return true
  } catch (e) {
    return e.status === 404 ? false : undefined
  }
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

/**
 * Earlier turns for the model, starting at a user message: user messages and final answers
 * only. Tool calls and outputs stay in the database but are not sent again (see history.js).
 */
async function loadHistory(user, sessionId) {
  const { ChatMessage } = E()
  const rows = await db(user, (tx) =>
    tx.run(SELECT.from(ChatMessage).where({ session_ID: sessionId, role: { in: ['user', 'assistant'] }, toolCalls: null }).orderBy('seq desc').limit(HISTORY_LIMIT))
  )
  rows.reverse()
  while (rows.length && rows[0].role !== 'user') rows.shift()
  return history.pastTurns(rows.map((m) => ({ role: m.role, content: m.content || '' })))
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
          toolCalls: m.tool_calls ? JSON.stringify(m.tool_calls) : m.tool_call_id ? JSON.stringify({ tool_call_id: m.tool_call_id }) : null,
          usage: m.usage ? JSON.stringify(m.usage) : null
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
    session: await tx.run(SELECT.one.from(ChatSession, sessionId).columns('defaults', 'draftSpec'))
  }))
  const defaults = session?.defaults ? JSON.parse(session.defaults) : null
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
    defaultsContext(defaults, defaults?.packageId ? await packageExists(defaults.packageId) : undefined),
    draftContext(session?.draftSpec ? JSON.parse(session.draftSpec) : null),
    attachmentsContext(await attachmentStore.list(user, sessionId))
  ].filter(Boolean)
  return { role: 'system', content: `${SYSTEM_PROMPT}\n\n## Context\n${context.join('\n')}` }
}

// --- progress events ------------------------------------------------------------------

const event = (type, label, detail) => ({ at: new Date().toISOString(), type, label, ...(detail && { detail }) })

/** Human-readable progress label for a tool call */
function toolLabel(name, args) {
  if (name === 'proposeIflow' || name === 'proposeIflowUpdate' || name === 'validateSpec') return 'Validating spec'
  if (name === 'proposePackage') return 'Validating package proposal'
  if (name === 'writeScript') return `Writing script ${args?.fileName || ''}.groovy`
  if (name === 'editDraftSpec') return 'Writing spec'
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
async function startTurn({ sessionId, message, defaults, attachments = [], user }) {
  if (!message || !String(message).trim()) throw fail(400, 'EMPTY_MESSAGE', 'Message is empty')
  const sessionDefaults = normalizeDefaults(defaults)
  ;(attachments || []).forEach(attachmentStore.check) // fail before a new session is created
  sessionId = await ensureSession(user, sessionId, message)
  const { ChatTurn, ChatSession } = E()
  if (sessionDefaults)
    await db(user, (tx) => tx.run(UPDATE(ChatSession, sessionId).set({ defaults: Object.keys(sessionDefaults).length ? JSON.stringify(sessionDefaults) : null })))
  if (attachments?.length) await attachmentStore.save(user, sessionId, attachments)

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

  // AI usage of this turn, summed over the model calls that answered
  const started = Date.now()
  const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, models: new Set() }
  const count = (res) => {
    const u = res.usage || {}
    usage.modelCalls++
    usage.inputTokens += u.inputTokens || 0
    usage.outputTokens += u.outputTokens || 0
    usage.totalTokens += u.totalTokens || 0
    if (res.model) usage.models.add(res.model)
  }
  /** Usage as stored on the turn and on its final answer */
  const budget = tokenBudget()
  let stoppedAtBudget = false
  let lastErrors = null // errors of the last failed validation or proposal
  const usageNow = () => {
    const { models, ...counts } = usage
    return { ...counts, durationMs: Date.now() - started, model: [...models].join(', ') || null, tokenBudget: budget, stoppedAtBudget }
  }

  /** What is done and what is left when the token budget stops the message (no model call needed) */
  const budgetStopText = async () => {
    const { ChatSession } = E()
    const s = await db(user, (tx) => tx.run(SELECT.one.from(ChatSession, sessionId).columns('draftSpec')))
    const draft = s?.draftSpec ? JSON.parse(s.draftSpec).spec : null
    const proposed = (await loadProposals(user, ctx.proposals)).filter((p) => p.kind === 'IFLOW')
    const done = [
      ...(ctx.written?.length ? [`scripts written: ${[...new Set(ctx.written)].join(', ')}`] : []),
      ...(draft ? [`draft spec ${draft.id || ''} with ${draft.steps?.length || 0} steps`] : []),
      ...proposed.map((p) => `proposal for ${p.iflowId} is ready for review`)
    ]
    const left = proposed.length
      ? 'nothing for this request'
      : lastErrors?.length
        ? `fix ${lastErrors.length} error(s), e.g. ${lastErrors[0]}, and propose the iFlow`
        : 'complete the spec and propose the iFlow'
    return [
      `I stopped because this message reached its token budget (${Math.round(usage.totalTokens / 1000)}k of ${Math.round(budget / 1000)}k tokens).`,
      `Done so far: ${done.length ? done.join('; ') : 'nothing that is kept'}.`,
      `Left: ${left}.`,
      proposed.length ? '' : 'The draft and the scripts are kept: send "continue" to resume where I stopped.'
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  const turn = [{ role: 'user', content: message }]
  const finish = async (text, messages = turn) => {
    const u = usageNow()
    await saveMessages(user, sessionId, [...messages, { role: 'assistant', content: text, usage: u }])
    const proposals = await loadProposals(user, ctx.proposals)
    events.push(event('done', 'Answer ready'))
    await update({ status: 'DONE', text, proposals: JSON.stringify(proposals), ...u })
  }
  try {
    const past = await loadHistory(user, sessionId)
    const system = await systemMessage(user, sessionId)
    let text = null
    let cutOffs = 0

    for (let i = 0; i < maxIterations() && text === null; i++) {
      await checkCancel()
      if (usage.totalTokens >= budget) {
        stoppedAtBudget = true
        await emit('info', `Token budget of ${Math.round(budget / 1000)}k reached — stopping`)
        text = await budgetStopText()
        break
      }
      if (i > 0) await emit('thinking', 'Thinking…')
      // while the answer streams in: "~1,200 tokens so far" on the current progress line, every 3s at most
      let shownAt = 0
      const onProgress = ({ outputChars, reasoningChars }) => {
        const tokens = Math.round((outputChars + reasoningChars) / 4)
        if (tokens < MIN_PROGRESS_TOKENS || Date.now() - shownAt < 3000) return
        shownAt = Date.now()
        events[events.length - 1].detail = `~${tokens.toLocaleString('en-US')} tokens so far`
        update().catch(() => {})
      }
      const res = await llm.chat({ messages: [system, ...past, ...history.compactTurn(turn)], tools: tools.definitions, signal, onProgress })
      count(res)
      const { message: msg, finish_reason: finish } = res.choices[0]
      if (res.fallbackUsed) await emit('info', `Answered by fallback model ${res.model}`)

      // Cut off at the output limit: a truncated tool call cannot be used. The model continues in parts.
      if (finish === 'length') {
        if (++cutOffs > MAX_CUT_OFFS) {
          text = 'My answers were cut off several times because they got too long. Please narrow down the request or split it into parts.'
          break
        }
        await emit('info', 'Answer cut off at the length limit — continuing in parts')
        turn.push({ role: 'user', content: history.NOTE_PREFIX + CUT_OFF_NOTE })
        continue
      }

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
          if (name === 'validateSpec') {
            const r = parseArgs(content)
            lastErrors = r.valid ? null : r.errors || lastErrors
            if (!r.valid) await emit('validation', 'Spec has errors — revising', r.errors ? `${r.errors.length} error(s)` : r.error?.message)
          } else if (name === 'proposeIflow' || name === 'proposeIflowUpdate' || name === 'proposePackage') {
            const r = parseArgs(content)
            lastErrors = r.valid ? null : r.errors || lastErrors
            if (r.valid) await emit('proposal', name === 'proposeIflowUpdate' ? 'Update proposal ready' : 'Proposal ready', name === 'proposePackage' ? args.id : r.iflowId)
            else await emit('validation', 'Spec has errors — revising', r.errors ? `${r.errors.length} error(s)` : r.error?.message)
          }
        }
        continue
      }

      text = msg.content || 'I could not produce an answer. Please rephrase your request.'
    }
    if (text === null) text = `I stopped after ${maxIterations()} steps without finishing. Please tell me how to continue, or narrow down the request.`
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
    const u = usageNow()
    // Keep the conversation readable and consistent: user message + a note, no partial tool exchange
    await saveMessages(user, sessionId, [turn[0], { role: 'assistant', content: note, usage: u }]).catch((err) => LOG.error('Could not save failed turn', err))
    const proposals = await loadProposals(user, ctx.proposals).catch(() => [])
    events.push(wasCancelled ? event('cancelled', 'Cancelled') : event('error', e.message))
    await update({
      ...u,
      status: wasCancelled ? 'CANCELLED' : 'FAILED',
      proposals: JSON.stringify(proposals),
      error: wasCancelled ? null : JSON.stringify({ code: e.code || 'AGENT_ERROR', message: e.message, hint: e.hint })
    }).catch((err) => LOG.error('Could not save turn status', err))
    if (!wasCancelled) LOG.warn(`Turn ${turnId} failed: ${e.code} ${e.message}`)
  }
}

/**
 * Imports an iFlow (.zip or .iflw) as the conversation's draft spec: its scripts and XSLT files
 * become attachments, and a short note in the chat tells the user (and the model) what came in.
 */
async function importIntoSession({ sessionId, fileName, buffer, packageId, user }) {
  const { ChatSession, ChatTurn } = E()
  if (sessionId) {
    const s = await db(user, (tx) => tx.run(SELECT.one.from(ChatSession, sessionId).columns('defaults')))
    if (!s) throw fail(404, 'SESSION_NOT_FOUND', `Chat session ${sessionId} not found`)
    packageId ||= s.defaults ? JSON.parse(s.defaults).packageId : undefined
    if (await db(user, (tx) => tx.run(SELECT.one.from(ChatTurn).columns('ID').where({ session_ID: sessionId, status: 'RUNNING' }))))
      throw fail(409, 'TURN_IN_PROGRESS', 'The assistant is still working in this conversation. Wait for it or cancel it, then import.')
  }
  const result = await importIflow(buffer, { fileName, packageId })
  sessionId = await ensureSession(user, sessionId, `Import ${fileName}`)
  const files = Object.entries(result.attachments).map(([name, content]) => ({ fileName: name, content }))
  if (files.length) await attachmentStore.save(user, sessionId, files, 'import')
  const draft = { spec: result.spec, source: `imported from ${fileName}`, valid: false, at: new Date().toISOString() }
  await db(user, (tx) => tx.run(UPDATE(ChatSession, sessionId).set({ draftSpec: JSON.stringify(draft) })))

  const { spec } = result
  const stepList = (steps) => steps.map((s, i) => `${i + 1}. ${s.name}${/^REPLACE WITH /.test(s.description || '') ? ' *(placeholder)*' : ''}`).join('\n')
  const summary = [
    `Imported **${spec.name}** (\`${spec.id}\`) from ${fileName} as the draft spec: ${spec.trigger.type === 'timer' ? 'timer, run once' : `HTTPS ${spec.trigger.address}`}, ${spec.steps.length} steps.`,
    stepList(spec.steps),
    ...(spec.exceptionSubprocess ? [`Exception subprocess: ${spec.exceptionSubprocess.steps.map((s) => s.name).join(', ')}`] : []),
    ...(result.notes.length ? ['Notes:', ...result.notes.map((n) => `- ${n}`)] : []),
    ...(result.valid ? [] : ['The draft does not validate yet:', ...result.errors.map((e) => `- ${e}`)]),
    'Ask me to propose it as a new iFlow, or to change it first.'
  ].join('\n\n')
  await saveMessages(user, sessionId, [
    { role: 'user', content: `Import the iFlow from ${fileName}.` },
    { role: 'assistant', content: summary }
  ])
  return { sessionId, spec, notes: result.notes, attachments: files.map((f) => f.fileName), placeholders: result.placeholders, valid: result.valid, errors: result.errors }
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
  const { ChatSession, ChatMessage, ChatTurn, Proposal, Attachment } = E()
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
    await tx.run(DELETE.from(Attachment).where({ session_ID: sessionId }))
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

module.exports = { startTurn, cancelTurn, deleteSession, importIntoSession, recoverInterruptedTurns, toProposalInfo, toolLabel, INTERRUPTED }
