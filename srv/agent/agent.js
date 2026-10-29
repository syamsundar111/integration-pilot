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
// longest a message may run; a turn still RUNNING after that (plus a minute) was left by a crashed instance
const maxTurnMs = () => Number(process.env.AGENT_MAX_TURN_MS || 3_600_000)
const STALE_GRACE_MS = 60_000
const MIN_PROGRESS_TOKENS = 50 // the "~N tokens so far" line appears from this size on
const MAX_CUT_OFFS = 2 // answers cut off for length per message before the agent gives up
const MAX_REPEATED_CALLS = 3 // the same refused tool call sent this often (no success in between): the message stops
const tokenBudget = () => Number(process.env.AGENT_MAX_TOKENS_PER_MESSAGE || 300_000) // input + output tokens per user message
const CUT_OFF_NOTE =
  'Your previous response was cut off because it reached the output limit; nothing of it was used. Build the spec in parts instead: ' +
  'write each Groovy script with writeScript, then editDraftSpec with {"op":"set",...} and addSteps (at most 8 steps per call), then proposeIflow with { "useDraftSpec": true }.'
/** True when tool-call arguments are complete JSON (the call was not cut off) */
const completeJson = (args) => {
  try {
    const v = JSON.parse(args || '{}')
    return v !== null && typeof v === 'object'
  } catch {
    return false
  }
}
/** What the model is told after a cut-off answer whose finished tool calls were run */
const cutOffKeptNote = (finished) => {
  const what = finished.map((tc) => `${tc.function.name}${tc.function.arguments.match(/"fileName"\s*:\s*"([^"]+)"/)?.[1] ? ` ${tc.function.arguments.match(/"fileName"\s*:\s*"([^"]+)"/)[1]}` : ''}`)
  return `Your previous answer was cut off at the output limit. Its finished tool calls were run and their results are above (${what.join(', ')}); only the unfinished part was dropped. Continue from there in smaller answers: at most 3 writeScript calls per answer, then the spec in one proposeIflow call.`
}
const HISTORY_LIMIT = 40 // earlier user messages and answers sent back to the model
const INTERRUPTED = 'Interrupted by server restart — please send your message again.'
const { toPackageId } = require('../lib/package-id')

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8')

/**
 * Conditional system prompt sections (srv/agent/prompt-sections/*.md), appended after the core prompt
 * only while a conversation needs them. The core stays first and identical in every call (a stable
 * prefix for prompt caching); a section, once included, stays for the rest of the conversation
 * (sticky), so the rules do not change between messages. Order is fixed, not the order of activation.
 */
const UNSUPPORTED_TEXT = /\b(router|splitter|gather|multicast|aggregator|join(?!\s+(to|with|on|by)\b)|xslt|(message|graphical|operation|xml|edmx|value)\s+mapping|mapping\s+(step|artifact)|sftp|write variables?|process ?call|processdirect|local integration process)\b/i
const PROMPT_SECTIONS = [
  // the conversation has files (attached, written by the assistant, from an iFlow or an import)
  { name: 'attachedFiles', applies: ({ files }) => files.length > 0 },
  // unsupported step kinds are mentioned, or the draft has REPLACE WITH placeholders (e.g. an import)
  { name: 'unsupportedSteps', applies: ({ userText, placeholders }) => placeholders > 0 || UNSUPPORTED_TEXT.test(userText) }
].map((s) => ({ ...s, text: fs.readFileSync(path.join(__dirname, 'prompt-sections', `${s.name}.md`), 'utf8').trim() }))

const db = (user, fn) => cds.tx({ user }, fn)
const E = () => cds.entities('iflowpilot')
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

/** AbortControllers of turns running in this process */
const running = new Map()

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

// --- persistence -------------------------------------------------------------------

/**
 * The conversation if `user` owns it (createdBy), else a 404: conversations are private, and another
 * user's conversation answers like a missing one. Every entry that takes a session id checks this; the
 * agent's own database access does not go through the service's @restrict.
 */
async function ownSession(tx, user, sessionId, columns = ['ID']) {
  const s = await tx.run(SELECT.one.from(E().ChatSession).columns(...columns).where({ ID: sessionId, createdBy: user?.id ?? null }))
  if (!s) throw fail(404, 'SESSION_NOT_FOUND', `Chat session ${sessionId} not found`)
  return s
}

async function ensureSession(user, sessionId, firstMessage) {
  const { ChatSession } = E()
  return db(user, async (tx) => {
    if (sessionId) {
      await ownSession(tx, user, sessionId)
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

/** System prompt + live context: date and the status of this session's proposals */
async function systemMessage(user, sessionId, message = '') {
  const { Proposal, ChatSession } = E()
  const { proposals, session } = await db(user, async (tx) => ({
    proposals: await tx.run(SELECT.from(Proposal).where({ session_ID: sessionId }).orderBy('createdAt')),
    session: await tx.run(SELECT.one.from(ChatSession, sessionId).columns('draftSpec', 'promptSections'))
  }))
  const files = await attachmentStore.list(user, sessionId)
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
    draftContext(session?.draftSpec ? JSON.parse(session.draftSpec) : null),
    attachmentsContext(files)
  ].filter(Boolean)
  const sections = await promptSections(user, sessionId, session, { files, message })
  return { role: 'system', content: `${SYSTEM_PROMPT}${sections.map((s) => `\n\n${s.text}`).join('')}\n\n## Context\n${context.join('\n')}` }
}

/** The conditional sections this conversation uses: those used before (sticky) plus those it needs now */
async function promptSections(user, sessionId, session, { files, message }) {
  const used = new Set(session?.promptSections ? JSON.parse(session.promptSections) : [])
  const draft = session?.draftSpec ? JSON.parse(session.draftSpec).spec : null
  const placeholders = [...(draft?.steps || []), ...(draft?.exceptionSubprocess?.steps || [])].filter((s) => /^REPLACE WITH /.test(s?.description || '')).length
  const { ChatMessage } = E()
  const past = await db(user, (tx) => tx.run(SELECT.from(ChatMessage).columns('content').where({ session_ID: sessionId, role: 'user' })))
  const userText = [...past.map((m) => m.content || ''), message].join('\n')
  const before = used.size
  for (const s of PROMPT_SECTIONS) if (!used.has(s.name) && s.applies({ files, userText, placeholders })) used.add(s.name)
  if (used.size !== before) {
    const { ChatSession } = E()
    await db(user, (tx) => tx.run(UPDATE(ChatSession, sessionId).set({ promptSections: JSON.stringify(PROMPT_SECTIONS.map((s) => s.name).filter((n) => used.has(n))) })))
  }
  return PROMPT_SECTIONS.filter((s) => used.has(s.name))
}

/**
 * "What changed" for the update proposals of a turn, built from the stored diff (spec and script
 * contents against the current iFlow), so the answer never shows changes the proposal does not make.
 */
async function changeSummary(user, ids) {
  if (!ids.length) return ''
  const { Proposal } = E()
  const rows = await db(user, (tx) => tx.run(SELECT.from(Proposal).columns('iflowId', 'operation', 'changes').where({ ID: { in: ids }, operation: 'UPDATE' })))
  const blocks = rows
    .filter((p) => p.changes)
    .map((p) => {
      const { list = [], scripts = {} } = JSON.parse(p.changes)
      const lines = [
        ...list.filter((c) => !/^script \S+ (changed|added)$/.test(c)).map((c) => `- ${c}`),
        ...Object.entries(scripts).map(([f, s]) => `- Script \`${f}\`: ${s === 'unchanged' ? 'unchanged from the iFlow' : s === 'new' ? 'new' : 'changed'}`)
      ]
      return `**What changed in ${p.iflowId}** (from the proposal, compared with the current iFlow):\n${lines.join('\n')}`
    })
  return blocks.length ? `\n\n---\n${blocks.join('\n\n')}` : ''
}

/**
 * After an "already exists" refusal in this turn, a proposal that was stored anyway (under another id)
 * gets a fixed note in the answer, so the user always sees that it creates a separate iFlow.
 */
async function duplicateNote(user, ctx) {
  if (!ctx.duplicates?.length || !ctx.proposals.length) return ''
  const { Proposal } = E()
  const rows = await db(user, (tx) => tx.run(SELECT.from(Proposal).columns('iflowId', 'packageId').where({ ID: { in: ctx.proposals }, kind: 'IFLOW', operation: 'CREATE' })))
  const notes = rows.flatMap((p) => {
    const d = ctx.duplicates.find((x) => x.id !== p.iflowId)
    return d
      ? [`**Note:** an iFlow "${d.name}" already exists (id ${d.id} in ${d.packageId}). This proposal creates a separate iFlow with the id ${p.iflowId} in ${p.packageId}. Reject it if you meant to update the existing one.`]
      : []
  })
  return notes.length ? `\n\n---\n${notes.join('\n\n')}` : ''
}

// --- an existing iFlow, before the model starts --------------------------------------------

/** Create request with a quoted name: Create an iFlow "Order Intake" (as in the request template) */
const CREATE_NAMED = /\bcreate\b[^\n"“]{0,40}\bi-?flow\b[^\n"“]{0,30}["“]([^"”\n]{2,100})["”]/i
/** A "Package: Demo.Integrations, name …" line: the package id (or a name, turned into an id) */
const PACKAGE_LINE = /^\s*package\s*:\s*([^,\n]+)/im

/**
 * If the message asks to create an iFlow by name and that iFlow exists already (an id the name
 * gives, anywhere on the tenant, or the same name in the target package), the answer that asks the
 * user what to do; null otherwise or when CPI cannot be asked (the model then runs as usual, and
 * proposeIflow still refuses a duplicate). Saves the whole model run: the scripts and the spec would
 * be written before the duplicate shows.
 */
async function existingIflowAnswer(user, sessionId, message) {
  const name = String(message || '').match(CREATE_NAMED)?.[1]?.trim()
  if (!name) return null
  const fromLine = String(message).match(PACKAGE_LINE)?.[1]?.trim()
  const packageId = fromLine ? toPackageId(fromLine.replace(/^["“]|["”]$/g, '')).id : null
  const ids = [...new Set([name.replace(/\s+/g, '_'), name.replace(/\s+/g, '')].map((id) => id.replace(/[^A-Za-z0-9_.-]/g, '')).filter(Boolean))]
  try {
    let found = null
    for (const id of ids) {
      found = await cpi.getIflow(id).catch((e) => {
        if (e.status === 404) return null
        throw e
      })
      if (found) break
    }
    if (!found && packageId) {
      const list = await cpi.listIflows(packageId).catch((e) => {
        if (e.status === 404) return [] // the package does not exist yet: nothing in it
        throw e
      })
      found = list.find((f) => String(f.name || '').trim().toLowerCase() === name.toLowerCase()) || null
    }
    if (!found) return null
    const where = found.packageId || packageId
    // an id clash holds on the whole tenant; a name clash only in that package
    const why = ids.includes(found.id)
      ? 'iFlow IDs are unique on the whole tenant, so it cannot be created again in another package under this ID.'
      : 'Names are unique within a package.'
    const free = await freeName(name, packageId)
    return [
      `An iFlow **"${found.name || found.id}"** (id \`${found.id}\`) already exists in package \`${where}\`. ${why} Nothing has been proposed yet.`,
      '',
      'What should I do?',
      `- **Update the existing iFlow**: say "update it" and what to change.`,
      free
        ? `- **Create a new iFlow as "${free.name}"** (id \`${free.id}\`): just say "okay". The package is the one in your message, otherwise the first package; you can change it in the proposal panel.`
        : null,
      `- **Use another name**: tell me the name.`
    ]
      .filter((l) => l !== null)
      .join('\n')
  } catch (e) {
    LOG.info(`Check for an existing iFlow '${name}' skipped: ${e.message}`)
    return null
  }
}

/**
 * The first of "<name> 2" … "<name> 5" whose id is free on the tenant and whose name is free in the
 * package of the message; null if none is (or CPI cannot be asked), then the user names one
 */
async function freeName(name, packageId) {
  const inPackage = packageId ? await cpi.listIflows(packageId).catch(() => []) : []
  for (let n = 2; n <= 5; n++) {
    const candidate = `${name} ${n}`
    const id = candidate.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '')
    if (inPackage.some((f) => String(f.name || '').trim().toLowerCase() === candidate.toLowerCase())) continue
    const taken = await cpi.getIflow(id).then(
      () => true,
      (e) => (e.status === 404 ? false : null)
    )
    if (taken === null) return null
    if (!taken) return { name: candidate, id }
  }
  return null
}

// --- progress events ------------------------------------------------------------------

const event = (type, label, detail) => ({ at: new Date().toISOString(), type, label, ...(detail && { detail }) })

/** Human-readable progress label for a tool call */
function toolLabel(name, args) {
  if (name === 'proposeIflow' || name === 'proposeIflowUpdate' || name === 'validateSpec') return 'Validating spec'
  if (name === 'proposePackage') return 'Validating package proposal'
  if (name === 'writeScript') return `Writing script ${args?.fileName || ''}.groovy`
  if (name === 'editDraftSpec') return 'Writing spec'
  if (name === 'getPattern') return `Reading pattern ${args?.name || ''}`.trim()
  if (name === 'getSampleResponse') return 'Reading a sample response'
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

const STALE = 'This message did not finish: the server stopped working on it. Please send it again.'

/**
 * RUNNING turns of the session that are older than the maximum turn time are left over from a crashed
 * instance (no turn runs longer, see startTurn): they are marked FAILED, with the question kept in the
 * history, so the conversation is not blocked. One app instance (mta.yaml); proper locking comes before
 * scaling out.
 */
async function expireStaleTurns(user, sessionId) {
  const { ChatTurn } = E()
  const cutoff = new Date(Date.now() - maxTurnMs() - STALE_GRACE_MS).toISOString()
  const stale = await db(user, (tx) => tx.run(SELECT.from(ChatTurn).columns('ID', 'message', 'events').where({ session_ID: sessionId, status: 'RUNNING', createdAt: { '<': cutoff } })))
  for (const t of stale) {
    const events = t.events ? JSON.parse(t.events) : []
    events.push(event('error', STALE))
    await db(user, (tx) =>
      tx.run(UPDATE(ChatTurn, t.ID).set({ status: 'FAILED', events: JSON.stringify(events), error: JSON.stringify({ code: 'TURN_STALE', message: STALE }) }).where({ status: 'RUNNING' }))
    )
    await saveMessages(user, sessionId, [{ role: 'user', content: t.message }, { role: 'assistant', content: `⚠️ ${STALE}` }]).catch((err) => LOG.error('Could not save stale turn', err))
    LOG.warn(`Chat turn ${t.ID} was RUNNING for longer than the maximum turn time; marked FAILED`)
  }
  return stale.length
}

/**
 * Starts a turn and returns immediately; the agent runs in the background.
 * @returns {Promise<{ turnId: string, sessionId: string, status: 'RUNNING' }>}
 */
async function startTurn({ sessionId, message, attachments = [], user }) {
  if (!message || !String(message).trim()) throw fail(400, 'EMPTY_MESSAGE', 'Message is empty')
  ;(attachments || []).forEach(attachmentStore.check) // fail before a new session is created
  sessionId = await ensureSession(user, sessionId, message)
  await expireStaleTurns(user, sessionId)
  const { ChatTurn } = E()
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
  // the maximum turn time: the turn is stopped and ends FAILED (a stale-turn check relies on this limit)
  const limit = setTimeout(() => controller.abort(fail(504, 'TURN_TIMEOUT', `The message took longer than ${Math.round(maxTurnMs() / 60_000)} minutes and was stopped.`)), maxTurnMs())
  runTurn({ turnId, sessionId, message: String(message), user, signal: controller.signal })
    .catch((e) => LOG.error(`Turn ${turnId} crashed`, e))
    .finally(() => {
      clearTimeout(limit)
      running.delete(turnId)
    })
  return { turnId, sessionId, status: 'RUNNING' }
}

async function runTurn({ turnId, sessionId, message, user, signal }) {
  const { ChatTurn } = E()
  const ctx = { user, sessionId, proposals: [], message } // message: for checks against what the user sent
  const events = [event('thinking', 'Thinking…')]
  const update = (patch = {}) => db(user, (tx) => tx.run(UPDATE(ChatTurn, turnId).set({ events: JSON.stringify(events), ...patch })))
  const emit = (type, label, detail) => {
    events.push(event(type, label, detail))
    return update()
  }
  // Cancel works across instances via the DB flag, and instantly in-process via the signal
  const checkCancel = async () => {
    if (signal.aborted && signal.reason?.code === 'TURN_TIMEOUT') throw signal.reason
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
  const refused = new Map() // "<tool> <arguments>" of refused calls in this turn → { times, error }
  let stuck = null // set when one refused call was sent MAX_REPEATED_CALLS times: the turn stops
  const usageNow = () => {
    const { models, ...counts } = usage
    return { ...counts, durationMs: Date.now() - started, model: [...models].join(', ') || null, tokenBudget: budget, stoppedAtBudget }
  }

  /** What is done and what is left when the message is stopped early (no model call needed) */
  const stopText = async (why) => {
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
      `I stopped because ${why}.`,
      `Done so far: ${done.length ? done.join('; ') : 'nothing that is kept'}.`,
      `Left: ${left}.`,
      proposed.length ? '' : 'The draft and the scripts are kept: send "continue" to resume where I stopped.'
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  const turn = [{ role: 'user', content: message }]
  const finish = async (text, messages = turn) => {
    text += await changeSummary(user, ctx.proposals) // the actual changes, never the model's account of them
    text += await duplicateNote(user, ctx) // proposed under another id after "already exists": always said
    const u = usageNow()
    await saveMessages(user, sessionId, [...messages, { role: 'assistant', content: text, usage: u }])
    const proposals = await loadProposals(user, ctx.proposals)
    events.push(event('done', 'Answer ready'))
    await update({ status: 'DONE', text, proposals: JSON.stringify(proposals), ...u })
  }
  try {
    // a create request for an iFlow that exists already: answered by the app, before any model call
    const exists = await existingIflowAnswer(user, sessionId, message)
    if (exists) {
      await emit('info', 'The iFlow exists already — asking first')
      return await finish(exists)
    }
    const past = await loadHistory(user, sessionId)
    const system = await systemMessage(user, sessionId, message)
    let text = null
    let cutOffs = 0

    for (let i = 0; i < maxIterations() && text === null; i++) {
      await checkCancel()
      if (usage.totalTokens >= budget) {
        stoppedAtBudget = true
        await emit('info', `Token budget of ${Math.round(budget / 1000)}k reached — stopping`)
        text = await stopText(`this message reached its token budget (${Math.round(usage.totalTokens / 1000)}k of ${Math.round(budget / 1000)}k tokens)`)
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

      // Cut off at the output limit: the finished tool calls of the answer are run (e.g. the scripts written
      // so far); only the unfinished one is dropped and redone. Without a finished call the answer is lost.
      if (finish === 'length') {
        const finished = (msg.tool_calls || []).filter((tc) => tc?.function?.name && completeJson(tc.function.arguments))
        if (finished.length) {
          await emit('info', `Answer cut off at the length limit — kept ${finished.length} finished tool call(s), continuing`)
          await runToolCalls(finished, null)
          turn.push({ role: 'user', content: history.NOTE_PREFIX + cutOffKeptNote(finished) })
          continue // progress was made: not counted against MAX_CUT_OFFS (maxIterations still bounds the loop)
        }
        if (++cutOffs > MAX_CUT_OFFS) {
          text = 'My answers were cut off several times because they got too long. Please narrow down the request or split it into parts.'
          break
        }
        await emit('info', 'Answer cut off at the length limit — continuing in parts')
        turn.push({ role: 'user', content: history.NOTE_PREFIX + CUT_OFF_NOTE })
        continue
      }

      if (msg.tool_calls?.length) {
        await runToolCalls(msg.tool_calls, msg.content)
        if (stuck) {
          await emit('info', 'The same call failed repeatedly — stopping')
          text = await stopText(`the same step kept failing: ${stuck.name} was refused ${stuck.times} times with "${stuck.error}"`)
          break
        }
        continue
      }

      text = msg.content || 'I could not produce an answer. Please rephrase your request.'
    }
    if (text === null) text = `I stopped after ${maxIterations()} steps without finishing. Please tell me how to continue, or narrow down the request.`
    await finish(text)
  } catch (e) {
    await failTurn(e)
  }

  /** Runs tool calls in order and appends them and their results to the turn */
  async function runToolCalls(calls, text) {
    const toolCalls = calls.map(({ id, type, function: f }) => ({ id, type, function: { name: f.name, arguments: f.arguments || '{}' } }))
    turn.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
    for (const tc of toolCalls) {
      await checkCancel()
      const name = tc.function.name
      const args = parseArgs(tc.function.arguments)
      await emit('tool', toolLabel(name, args))
      // a call identical to one refused before in this turn is not run again: the result would be the same
      const key = `${name} ${tc.function.arguments.trim()}`
      const before = refused.get(key)
      let content
      if (before) {
        before.times++
        content = JSON.stringify({
          valid: false,
          errors: [`REPEATED_CALL: this ${name} call is identical to one refused before in this message, with: ${before.error}`],
          instruction: 'Do not send it again unchanged. Fix what the error says, or tell the user what blocks you.'
        })
        if (before.times >= MAX_REPEATED_CALLS) stuck = { name, times: before.times, error: before.error }
      } else {
        content = await tools.execute(name, tc.function.arguments, ctx)
        const r = parseArgs(content)
        if (r.valid === false || r.error) refused.set(key, { times: 1, error: String(r.errors?.[0] || r.error?.message || 'refused').slice(0, 200) })
        else refused.clear() // something worked: the draft may have changed, so an earlier refused call may now pass
      }
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
  }

  /** Ends the turn after an error or a cancel; a stored proposal still ends it DONE */
  async function failTurn(e) {
    if (signal.aborted && signal.reason?.code === 'TURN_TIMEOUT') e = signal.reason // the model call ends as "cancelled" on abort
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
    await db(user, (tx) => ownSession(tx, user, sessionId))
    await expireStaleTurns(user, sessionId)
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
  await tools.nameSession(user, sessionId, `${spec.name || spec.id}${spec.packageId ? ` · ${spec.packageId}` : ''}`)
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
  const turn = await db(user, (tx) => tx.run(SELECT.one.from(ChatTurn, turnId).columns('session_ID')))
  if (turn) await db(user, (tx) => ownSession(tx, user, turn.session_ID)).then(() => expireStaleTurns(user, turn.session_ID), () => {})
  await db(user, async (tx) => {
    const t = await tx.run(SELECT.one.from(ChatTurn, turnId))
    if (!t) throw fail(404, 'TURN_NOT_FOUND', `Turn ${turnId} not found`)
    await ownSession(tx, user, t.session_ID).catch(() => {
      throw fail(404, 'TURN_NOT_FOUND', `Turn ${turnId} not found`) // another user's turn looks like a missing one
    })
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
  await db(user, (tx) => ownSession(tx, user, sessionId))
  await expireStaleTurns(user, sessionId)
  await db(user, async (tx) => {
    await ownSession(tx, user, sessionId)
    await removeSession(tx, sessionId)
  })
}

/**
 * Deletes a conversation in the caller's transaction: its messages, turns, attachments and pending
 * proposals; executed proposals are kept without the link (Dashboard, backups and the audit log use them).
 * Refused while the assistant works in it or one of its proposals is executing.
 */
async function removeSession(tx, sessionId) {
  const { ChatSession, ChatMessage, ChatTurn, Proposal, Attachment } = E()
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
}

/** Days of inactivity after which a conversation is deleted (0 = never); env CONVERSATION_RETENTION_DAYS */
const retentionDays = () => {
  const days = Number(process.env.CONVERSATION_RETENTION_DAYS ?? 14)
  return Number.isFinite(days) && days >= 0 ? days : 14
}

/**
 * Deletes conversations of all users without activity for `days` days, except kept ones (keep = true).
 * Activity is the latest of: a message saved or the conversation changed (modifiedAt), a request
 * started (ChatTurn), a proposal changed (approved, executed, rejected). Runs daily in the app, or
 * from a job (POST /api/cleanupConversations, e.g. SAP BTP Job Scheduler).
 * @returns {Promise<{ days: number, deleted: number, skipped: number }>}
 */
async function deleteInactiveSessions({ days = retentionDays(), now = Date.now() } = {}) {
  if (!days) return { days, deleted: 0, skipped: 0 }
  const { ChatSession, ChatTurn, Proposal } = E()
  const cutoff = new Date(now - days * 86_400_000).toISOString()
  const candidates = await db(undefined, (tx) =>
    tx.run(SELECT.from(ChatSession).columns('ID').where({ modifiedAt: { '<': cutoff } }).and({ keep: false, or: { keep: null } }))
  )
  let deleted = 0
  let skipped = 0
  for (const { ID } of candidates) {
    try {
      await db(undefined, async (tx) => {
        const recent =
          (await tx.run(SELECT.one.from(ChatTurn).columns('ID').where({ session_ID: ID, createdAt: { '>=': cutoff } }))) ||
          (await tx.run(SELECT.one.from(Proposal).columns('ID').where({ session_ID: ID, modifiedAt: { '>=': cutoff } })))
        if (recent) return skipped++ // active after all: a recent request or proposal
        await removeSession(tx, ID)
        deleted++
      })
    } catch (e) {
      skipped++ // e.g. a running turn or an executing proposal: next run
      LOG.info(`Conversation ${ID} not deleted now: ${e.message}`)
    }
  }
  return { days, deleted, skipped }
}

/** Keeps a conversation (never deleted by the inactivity cleanup) or releases it */
async function keepSession(sessionId, keep, user) {
  const { ChatSession } = E()
  return db(user, async (tx) => {
    await ownSession(tx, user, sessionId)
    await tx.run(UPDATE(ChatSession, sessionId).set({ keep: !!keep }))
    return tx.run(SELECT.one.from(ChatSession, sessionId).columns('ID', 'title', 'keep', 'modifiedAt'))
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

/** Renames a conversation; from then on its name is not changed automatically */
async function renameSession(sessionId, title, user) {
  const { ChatSession } = E()
  title = (title || '').replace(/\s+/g, ' ').trim()
  if (!title) throw fail(400, 'TITLE_REQUIRED', 'Enter a name for the conversation.')
  if (title.length > 200) throw fail(400, 'TITLE_TOO_LONG', 'The name can have at most 200 characters.')
  return db(user, async (tx) => {
    await ownSession(tx, user, sessionId)
    await tx.run(UPDATE(ChatSession, sessionId).set({ title, titleEdited: true }))
    return tx.run(SELECT.one.from(ChatSession, sessionId).columns('ID', 'title', 'titleEdited', 'modifiedAt'))
  })
}

module.exports = { startTurn, cancelTurn, deleteSession, renameSession, keepSession, deleteInactiveSessions, retentionDays, importIntoSession, recoverInterruptedTurns, toProposalInfo, toolLabel, INTERRUPTED }
