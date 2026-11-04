# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Integration Pilot: a CAP Node.js backend + freestyle SAPUI5 1.136 app (`app/integration-pilot/`) to manage
SAP Cloud Integration (CPI) packages/iFlows and generate iFlows from natural-language requests with an LLM agent.
It is the SAPUI5 counterpart of the sibling project `../iflow-pilot` (React): same backend design, own port
(4005), own database and XSUAA app; shares the CPI tenant, the destinations and the destination service
`iflowpilot-dest`. `../ip-measure-*` are copies of this repo used for model measurements — don't edit them
when working here.

## Commands

```bash
npm run watch:hybrid          # local run with real destinations (CPI_API, NVIDIA_LLM); needs `cf login`; http://localhost:4005
npm run watch                 # local run without destinations
npm test                      # jest, all backend tests (test/**/*.test.js)
npx jest test/builder.test.js # one test file;  add -t "<name>" for one test
npm run test:ui               # wdi5 UI tests (starts test/ui/fake-backend.cjs on 4011; needs internet for the UI5 CDN; HEADED=1 shows Chrome)
npm run ui:lint               # UI5 linter (run ui:install once first)
npm run ui:build              # builds app/integration-pilot/dist — CAP then serves dist instead of webapp; delete dist to go back
npm run templates:derive      # regenerate builder templates from the reference zips
scripts/test-chat.sh          # live agent conversation via curl against a running server
```

- The user usually has the server running on 4005. Don't start a second one; if you must start one for testing, stop it afterwards.
- Destinations only resolve when started through `cds bind --exec --profile hybrid -- …` (what `watch:hybrid` does).
- Locally every request is user `local-dev` with role `Admin` (`srv/lib/dev-auth.js`).
- `.env` holds `LLM_MODEL`, `LLM_FALLBACK_MODEL` and the LLM/agent limits documented in README.md. Real environment variables win over `.env`.

## Architecture

**REST API.** `srv/api-service.cds` (`@protocol: 'rest'` at `/api`) + `srv/api-service.js`. Paths are case-sensitive and
follow the CDS names (`/api/Packages`, `/api/Proposals/{id}/approve`); `server.js` adds a few dash aliases, serves the UI5
app at `/`, and on startup calls the recovery for interrupted turns and proposals.

**External systems — only via BTP destinations, never hardcoded URLs or secrets.**
- `srv/lib/cpi-client.js`: all CPI OData v2 calls (destination `CPI_API`, `/api/v1`), with a short read cache that writes invalidate.
  CPI quirks: no `$select` on IntegrationPackages; iFlows can only be listed per package.
- `srv/lib/llm.js`: the only LLM adapter (OpenAI-compatible `/chat/completions` via destination `NVIDIA_LLM`), streaming,
  idle/total timeouts, fallback model. Keep it provider-neutral.

**Agent (`srv/agent/`).** Chat is asynchronous: `chat` creates a `ChatTurn` (RUNNING) and returns right away. `agent.js` runs the
function-calling loop in the background and appends progress events; the UI polls the turn and can cancel it. Messages are written at
the end of a turn, so the history never has half-finished tool exchanges. The prompt is built from `system-prompt.md`, plus conditional
`prompt-sections/*.md` (sticky once triggered), plus `patterns/*.md` that the model loads on demand through a tool. Tools in `tools.js`
are read-only or *propose*: **the LLM never writes to CPI.** `proposeIflow` validates the spec and stores a PENDING `Proposal`.
Budgets: `AGENT_MAX_MODEL_CALLS`, `AGENT_MAX_TOKENS_PER_MESSAGE`, `AGENT_MAX_TURN_MS`.

**Proposal execution (`srv/lib/proposals.js`, no LLM).** approve → ensure package → build zip → create/update iFlow → set
configurations → optional deploy + runtime polling. It runs in-process in the background, writes progress to `Proposal.result`, and every
step is safe to re-run (`retry`). Updates keep a backup zip for `restore`. All writes go to the audit log (`srv/lib/audit.js`).
Because turns and approvals live in the process, the backend must stay at **`instances: 1`** (enforced by `test/repo-hygiene.test.js`).

**iFlow builder (`srv/iflow-builder/`).** The central data type is the *spec v1* (`spec-schema.json`): a trigger (httpsSender | soapSender | processDirectSender | jmsSender | sftpSender |
timer once | timer every N minutes), steps (contentModifier, groovyScript, writeVariables, jsonToXml, xmlToJson,
requestReplyHttp, requestReplySoap, requestReplyProcessDirect, sendMail, messageMapping, xsltMapping, router, splitter, gather, processCall, multicast) and an end (httpReceiver | processDirectReceiver | none, with a
Message/Escalation/Error End), plus optional `exceptionSubprocess` and `localProcesses`. Multicasts sit on the main line (the builder adds the Join, a gather follows, a branch holds steps, process calls, routers
with one continuing route and a closed split), splitters and gathers on the main line or a branch, routers on
the main line, a branch or a local process's line; a router's routes end or continue with the step after it; a splitter is flat
(the steps after it run per item until a gather, with no router in between); a processCall runs a local process (`spec-steps.js` lists all steps with their paths, `mapSteps` changes them). Spec values
that CPI stores differently are mapped in `cpi-values.js` (Content Modifier sources, Write Variables, timer schedules) and
`receiver-settings.js` (HTTP receivers); `sender-settings.js` holds what the builder writes fixed for each sender
adapter and the ProcessDirect receiver, maps SFTP sender values and decides whether Import and update keep them.
- `validator.js`: the schema plus rules. It returns human-readable errors meant for the LLM to fix.
- `builder.js`: spec → CPI zip, using `templates/`. The templates are derived by `derive-templates.js` from the exported zips in
  `reference/`, which are the **source of truth**. Never hand-write or guess CPI XML; extend the reference exports and re-derive.
- `parser.js`: zip → structure (Explain, the flow diagram); for a branching flow also `routed`, the routers as the spec
  holds them; `localProcessSteps`, the local processes. `to-spec.js` gives an exact parsed → spec mapping for updates, and refuses with blockers when it would lose content. `import.js` gives an approximate import of any iFlow, with placeholder steps for what the
  spec can't express.
- Groovy scripts are suggestions: not compiled or tested by the app (the developer tests them in CPI); the validator only
  requires the CPI entry point (import + processData) and refuses hard-coded secrets.

**UI (`app/integration-pilot/webapp/`).** XML views + JS controllers, hash routing, UI5 loaded from the SAP CDN, no build needed in
development. `util/api.js` is the REST client. Some UI modules (`util/promptLint.js`, controllers) are unit-tested from jest through a
minimal `sap.ui.define` stub (see `test/prompt-lint.test.js`). `app/router/` is the approuter for Cloud Foundry.

**Data.** `db/schema.cds` (namespace `iflowpilot`). SQLite `db.sqlite` locally (`schema_evolution: auto`), HANA Cloud via `mta.yaml`,
in-memory SQLite via `mta-sqlite.yaml` (demo only).

## Repository rules enforced by tests

- No client data in the repo: `test/no-client-data.test.js` checks against the git-ignored `test/local/forbidden-names.txt`.
  Client-specific fixtures belong in `test/local/` (ignored). Use neutral example names and placeholder URLs elsewhere.
- `.env`, `.cdsrc-private.json`, `default-env.json` and `db.sqlite*` must stay git-ignored.
- `test/system-prompt.test.js` and `test/prompt-guide.test.js` tie `srv/agent/system-prompt.md` and `docs/prompt-guide.md` to the
  builder. When you change a prompt rule, check that what it tells the model still validates and builds.
- Measurements: `scripts/measure-all.js` (usage in its header) writes to `docs/measurements.md`, which it creates
  on its first run; none is committed yet.

## Builder v2 (branch builder-v2)

Extends the builder beyond the linear spec v1; phases, status and open items: [docs/builder-v2-plan.md](docs/builder-v2-plan.md).

- Reference library: `srv/iflow-builder/reference/Ref_*.zip` plus `MM_DummyOrderToNotif.zip`, one prompt
  each in `test/reference-prompts/<name>.txt`. Dummy data only (example.com, s4dummy, DUMMY_*).
- `iglowpackage` (name "iglow package") is the package on the tenant where the app and Claude create iFlows, since the
  tenant was re-provisioned on 2026-11-04 (before: `iglow`). iGlow is also a tool used at the start, no longer in
  use: the first references were built with it, then corrected and saved in the CPI editor.
  Never trust AI-written dropdown values: they count only once selected in the editor (iGlow wrote invalid source
  types, Write Variables types and proxy types).
- Values count as selected only when the user says so. For an export the user builds from scratch in the CPI
  editor, that is every value. For a re-saved export (e.g. the Ref_Sender_SOAP re-export), only the values the
  user names. Those go into `reference/confirmed-values.json`.
- Allowed dropdown values come only from the references, per adapter and field (e.g. On-Premise =
  `sapcc`; Internet = `default` in HTTP/OData/SOAP but `none` in SFTP/Mail). A value seen in only one
  reference is a warning, not an error, unless it is listed in `reference/confirmed-values.json` (selected
  in the editor). `npm run templates:derive` merges both into `templates/reference-values.json` (a test fails
  when it is out of date); HTTP receiver settings map between spec and CPI in `receiver-settings.js`.
- Ignore what the iGlow tool added to references: empty exception subprocesses (Error Start -> Error End) and
  "Set log headers" steps. Derive nothing from them.
- Each scheduler is the template for its own component (Timer start event != SFTP adapter scheduler).
- Parser: the main process is the process without `processType=directCall` that no Process Call calls
  (older exports lack the property). More than one gives a warning, never a silent choice; the one with
  a timer or message start is shown.

## Working agreements

- One task per commit. Run `npm test` on each commit on its own (git worktree) before reporting. A worktree has no
  git-ignored files, so its counts are lower than in the main tree: the suites in `test/local/` don't exist there, and
  the 3 tests of `test/no-client-data.test.js` skip without `test/local/forbidden-names.txt`. So the client-data check
  only runs in the main tree: run it there before committing. One of them scans the commits not on a remote
  (`--branches --not --remotes`), so a name in an intermediate commit is caught before a push.
- Stop and report after each step. No commit without the user's OK.
- Push only when the user asks; before pushing, run the client-data scan over every unpushed commit, including zip
  versions, and never force-push.
- Builder or template changes are committed only after the user has created a test iFlow on the tenant
  and opened it in the CPI editor without errors.
- Update this file in the same commit when a change makes a section outdated, e.g. when a phase extends
  what the spec v1 description under Architecture says.
