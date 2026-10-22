#!/usr/bin/env node
/**
 * Runs the measurement scenarios several times against a running server and writes a summary
 * (median, min, max per scenario) to the top of docs/measurements.md.
 *
 *   node scripts/measure-all.js --api http://localhost:4005/api --log server.log [--runs 3]
 *        [--scenarios a,b,c,d] [--out results.jsonl] [--title "Before items 1-3"] [--no-docs]
 *   node scripts/measure-all.js --summarize results.jsonl --title "..."   (only write the summary)
 *
 * Scenarios (set v2, neutral, from 2026-10-22; rounds before that used client-specific scenarios
 * that are no longer in the repository, so their numbers are not comparable with later rounds):
 *   a  Users Summary, the model writes the scripts (first request + session defaults)
 *   b  Users Summary, scripts attached (improved request + session defaults)
 *   c  generic 30-step order flow
 *   d  rebuild of an existing iFlow with placeholders, 25 steps (docs/prompt-guide.md)
 * Start the server with the model you want to measure and GROOVY_CHECK_URL pointing at a running
 * Groovy check (real environment variables win over .env).
 */
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? fallback : args[i + 1]
}
const flag = (name) => args.includes(`--${name}`)

const SCENARIO_SET = 'v2 (neutral)'
const F = 'test/fixtures/users-summary'
const SCENARIOS = {
  a: { name: 'Users Summary, model writes scripts', args: ['--defaults'] },
  b: {
    name: 'Users Summary, scripts attached',
    args: ['--defaults', '--request', 'scripts/measure/users-summary-improved-request.md', '--attach', `${F}/summarizeUsers.groovy,${F}/buildErrorMessage.groovy`]
  },
  c: { name: '30-step generic order flow', args: ['--request', 'scripts/measure/large-order-request.md'] },
  d: { name: 'Placeholder rebuild, 25 steps', args: ['--request', 'scripts/measure/placeholder-rebuild-request.md'] }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
const stat = (rows, get, fmt = (x) => String(x)) => {
  const xs = rows.map(get).filter((x) => Number.isFinite(x))
  return xs.length ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})` : '–'
}

/** Markdown section for one measurement round */
function summary(rows, title) {
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
  const model = process.env.LLM_MODEL || readEnvFile('LLM_MODEL') || 'unknown'
  const lines = [
    `## ${new Date().toISOString().slice(0, 10)} · ${title || 'Measurement'}`,
    '',
    `Commit \`${commit}\` · model \`${model}\` · scenario set ${SCENARIO_SET} · ${rows.length} runs. Median (min–max) per scenario.`,
    '',
    '| Scenario | Runs | Proposal | Messages | Model calls | Input tokens | Output tokens | Time (min) | Largest prompt | Groovy checks ok / not checked |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const [key, sc] of Object.entries(SCENARIOS)) {
    const r = rows.filter((x) => x.scenario === key)
    if (!r.length) continue
    lines.push(
      `| (${key}) ${sc.name} | ${r.length} | ${r.filter((x) => x.outcome === 'iFlow proposal').length}/${r.length} | ${stat(r, (x) => x.turns)} | ${stat(r, (x) => x.modelCalls)} | ${stat(r, (x) => x.promptTokens, k)} | ${stat(r, (x) => x.completionTokens, k)} | ${stat(r, (x) => x.minutes, (m) => m.toFixed(1))} | ${stat(r, (x) => x.maxPromptTokens, k)} | ${stat(r, (x) => x.groovyChecks?.ok)} / ${stat(r, (x) => x.groovyChecks?.notChecked)} |`
    )
  }
  return lines.join('\n') + '\n'
}

function readEnvFile(name) {
  try {
    return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]
  } catch {
    return null
  }
}

/** Puts a section at the top of docs/measurements.md (newest first) */
function writeDocs(section) {
  const file = path.join(ROOT, 'docs', 'measurements.md')
  const header = '# Token and time measurements\n\nNewest first. How to measure: `scripts/measure-all.js`.\n\n'
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(header, '') : ''
  fs.writeFileSync(file, header + section + (old ? `\n${old}` : ''))
}

function main() {
  const title = opt('title')
  if (opt('summarize')) {
    const rows = fs.readFileSync(opt('summarize'), 'utf8').trim().split('\n').map(JSON.parse)
    const section = summary(rows, title)
    process.stdout.write(section)
    if (!flag('no-docs')) writeDocs(section)
    return
  }
  const runs = Number(opt('runs', 3))
  const out = opt('out', path.join(ROOT, 'measure-results.jsonl'))
  const keys = opt('scenarios', 'a,b,c,d').split(',')
  const common = ['--api', opt('api', 'http://localhost:4005/api'), '--log', opt('log'), '--max-turns', opt('max-turns', '5')]
  const rows = []
  for (let run = 1; run <= runs; run++)
    for (const key of keys) {
      const label = `${key}-${run}`
      process.stderr.write(`\n=== scenario (${key}) ${SCENARIOS[key].name}, run ${run}/${runs}\n`)
      const res = execFileSync(process.execPath, [path.join(__dirname, 'measure-tokens.js'), ...common, '--label', label, ...SCENARIOS[key].args], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 10 * 1024 * 1024
      })
      const row = { ...JSON.parse(res.toString().trim().split('\n').pop()), scenario: key }
      rows.push(row)
      fs.appendFileSync(out, JSON.stringify(row) + '\n')
    }
  const section = summary(rows, title)
  process.stdout.write(section)
  if (!flag('no-docs')) writeDocs(section)
}

main()
