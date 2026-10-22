#!/usr/bin/env node
/**
 * Token measurement for one chat session: sends the Users Summary request (scripts/measure/)
 * to a running server, answers follow-up questions, and stops at the first iFlow proposal.
 * Token usage is summed from the server log lines that srv/lib/llm.js writes per model call
 * ("<model>: <ms>ms, tokens prompt=<n> completion=<n> total=<n>"), so start the server with
 * its output redirected to a file and pass that file as --log.
 *
 *   node scripts/measure-tokens.js --log server.log [--api http://localhost:4005/api]
 *        [--defaults] [--label before] [--max-turns 5] [--out results.jsonl]
 *        [--request scripts/measure/users-summary-improved-request.md] [--attach a.groovy,b.groovy]
 *
 * --defaults sends the session defaults (package, timer, auth note) with every turn.
 * --request replaces the original request; --attach sends files with the first message.
 * Read-only on the tenant: proposals stay PENDING; nothing is approved.
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? fallback : args[i + 1]
}
const flag = (name) => args.includes(`--${name}`)

const API = opt('api', 'http://localhost:4005/api')
const LOG = opt('log')
const LABEL = opt('label', flag('defaults') ? 'with-defaults' : 'plain')
const MAX_TURNS = Number(opt('max-turns', 5))
const OUT = opt('out')
if (!LOG) {
  console.error('--log <server log file> is required')
  process.exit(2)
}

const DIR = path.join(__dirname, 'measure')
const FOLLOW_UP = 'Use sensible defaults for anything still open and propose the iFlow now.'
// A unique iFlow id per run, so the proposal never clashes with an existing iFlow
const suffix = `M${Date.now().toString(36)}`
const unique = (text) => text.replace(/RUNID/g, suffix) // requests mark the id with RUNID
const REQUEST = unique(fs.readFileSync(opt('request', path.join(DIR, 'users-summary-request.md')), 'utf8'))
const ATTACH = (opt('attach', '') || '').split(',').filter(Boolean).map((f) => ({ fileName: path.basename(f), content: fs.readFileSync(f, 'utf8') }))
// answers to clarifying questions: the Users Summary answers for the default request, else the generic follow-up
const ANSWERS = opt('request') ? FOLLOW_UP : fs.readFileSync(path.join(DIR, 'users-summary-answers.md'), 'utf8')

const DEFAULTS = {
  packageId: 'IntegrationPilot.Demo',
  timer: 'once',
  authNote: 'Both receivers (RCVR_Users, RCVR_Todos) need no authentication; keep authType None.'
}

async function call(method, url, body) {
  const res = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function runTurn(sessionId, message) {
  const body = { message, ...(sessionId && { sessionId }), ...(flag('defaults') && { defaults: DEFAULTS }), ...(!sessionId && ATTACH.length && { attachments: ATTACH }) }
  const started = await call('POST', '/chat', body)
  let seen = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    const t = await call('GET', `/chat/turns/${started.turnId}`)
    for (const e of (t.events || []).slice(seen)) console.error(`   · ${e.label}${e.detail ? ` (${e.detail})` : ''}`)
    seen = (t.events || []).length
    if (t.status !== 'RUNNING') return { ...t, sessionId: started.sessionId }
  }
}

/**
 * Groovy check outcomes in a session, from its tool results: writeScript / validateSpec / propose
 * results that checked scripts (ok), found syntax errors (failed) or could not check (notChecked),
 * and the number of scripts in the proposal.
 */
async function scriptChecks(sessionId) {
  const messages = await call('GET', `/ChatSessions/${sessionId}/messages?$orderby=seq`)
  const toolName = {}
  for (const m of messages) if (m.role === 'assistant' && m.toolCalls?.startsWith('[')) for (const tc of JSON.parse(m.toolCalls)) toolName[tc.id] = tc.function.name
  const out = { ok: 0, failed: 0, notChecked: 0, scriptsInProposal: 0 }
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const name = toolName[JSON.parse(m.toolCalls || '{}').tool_call_id]
    if (!['writeScript', 'validateSpec', 'proposeIflow', 'proposeIflowUpdate'].includes(name)) continue
    const content = m.content || ''
    if (content.includes('Groovy syntax not checked') || content.includes('GROOVY_NOT_CHECKED')) out.notChecked++
    else if (content.includes('GROOVY_SYNTAX')) out.failed++
    else if (name === 'writeScript' ? content.includes('"stored"') : content.includes('"valid":true')) out.ok++
  }
  const proposals = await call('GET', `/Proposals?$filter=${encodeURIComponent(`session_ID eq ${sessionId} and kind eq 'IFLOW'`)}`)
  const last = proposals.at(-1)
  if (last) out.scriptsInProposal = [...(last.spec?.steps || []), ...(last.spec?.exceptionSubprocess?.steps || [])].filter((st) => st.type === 'groovyScript').length
  return out
}

/** Model calls logged since `offset`: [{ prompt, completion }] plus failure lines */
function usageSince(offset) {
  const text = fs.readFileSync(LOG, 'utf8').slice(offset)
  const calls = [...text.matchAll(/tokens prompt=(\d+) completion=(\d+)/g)].map((m) => ({ prompt: Number(m[1]), completion: Number(m[2]) }))
  const failures = (text.match(/chat failed: \S+/g) || []).length
  const retries = (text.match(/, retry \d+ in /g) || []).length
  return { calls, failures, retries }
}

async function main() {
  const offset = fs.statSync(LOG).size
  const startedAt = Date.now()
  const messages = [REQUEST, ANSWERS]
  let sessionId = null
  let outcome = 'no proposal'
  let turns = 0
  const texts = []
  while (turns < MAX_TURNS) {
    const message = messages[turns] ?? FOLLOW_UP
    turns++
    console.error(`\n[${LABEL}] turn ${turns}: ${message.split('\n')[0].slice(0, 80)}…`)
    const t = await runTurn(sessionId, message)
    sessionId = t.sessionId
    texts.push({ status: t.status, chars: (t.text || '').length })
    console.error(`   => ${t.status}: ${(t.text || t.error?.message || '').split('\n')[0].slice(0, 160)}`)
    if ((t.proposals || []).some((p) => p.kind === 'IFLOW')) {
      outcome = 'iFlow proposal'
      break
    }
  }
  const { calls, failures, retries } = usageSince(offset)
  const sum = (k) => calls.reduce((n, c) => n + c[k], 0)
  const result = {
    label: LABEL,
    at: new Date(startedAt).toISOString(),
    outcome,
    turns,
    modelCalls: calls.length,
    failedCalls: failures,
    retries,
    promptTokens: sum('prompt'),
    completionTokens: sum('completion'),
    totalTokens: sum('prompt') + sum('completion'),
    maxPromptTokens: Math.max(0, ...calls.map((c) => c.prompt)),
    minutes: Math.round((Date.now() - startedAt) / 6000) / 10,
    sessionId,
    groovyChecks: sessionId ? await scriptChecks(sessionId).catch((e) => ({ error: e.message })) : null,
    groovyUnavailable: (fs.readFileSync(LOG, 'utf8').slice(offset).match(/Groovy syntax check unavailable: [^\n]*/g) || []).slice(0, 5),
    replies: texts
  }
  console.log(JSON.stringify(result))
  if (OUT) fs.appendFileSync(OUT, JSON.stringify(result) + '\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
