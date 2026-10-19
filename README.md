# Integration Pilot

AI assistant & **SAPUI5** dashboard for SAP Cloud Integration (CPI): manage packages and iFlows,
and generate iFlows from natural-language requirements.

Integration Pilot is the SAPUI5 counterpart of `iflow-pilot` (React). It has the same CAP Node.js
backend and the same features, but runs as a separate app with its own database, port and XSUAA app.
It shares the CPI tenant, the destinations and the AI model with `iflow-pilot`.

- **Backend:** CAP Node.js (`srv/`, `db/`), REST API at `/api`. Same services as iflow-pilot.
- **Frontend:** a freestyle **SAPUI5 1.136** app (long-term maintenance) in `app/integration-pilot/`.
  It uses the Horizon theme and XML views with JavaScript controllers, and loads UI5 from the SAP CDN.

## Screens

| Page | UI5 building blocks |
|---|---|
| Shell | `sap.tnt.ToolPage`: ToolHeader (tenant, live connection status, user) and SideNavigation (Overview / Build / History) |
| Dashboard | `sap.f.DynamicPage`, `GenericTile` KPIs, `sap.f.Card` lists (failed messages, recent proposals, quick actions) |
| Packages | `sap.m.Table` with search, create/edit Dialog (CPI id rules), delete with type-to-confirm and a warning about deployed iFlows |
| iFlows | `sap.f.FlexibleColumnLayout` list-detail; IconTabBar Overview (flow diagram, adapters) / Parameters (editable) / Scripts (`sap.ui.codeeditor` Groovy) / Runtime; Download, Deploy, Undeploy, Explain with AI, Delete; Explain from ZIP (`FileUploader`) |
| Generate | Chat (Markdown replies, request template with a pre-send check, session defaults, .groovy/.xsl attachments, Import iFlow, history, live agent steps with Cancel) and the proposal panel (target package check, flow diagram, steps, parameters, Groovy, approve / deploy / reject / retry with live progress). How to write requests: [docs/prompt-guide.md](docs/prompt-guide.md) |
| Monitor | Runtime artifacts with a status filter and error details, a "waiting for the runtime" notice, message logs with status/time filters |
| Activity | Audit log with search, action and result filters, and a details dialog |

## Project structure

```
db/schema.cds                       data model (namespace iflowpilot, shared with iflow-pilot's code)
srv/                                CAP service, CPI client, LLM adapter, agent, iFlow builder (same as iflow-pilot)
app/integration-pilot/              SAPUI5 app (UI5 Tooling project)
  webapp/index.html                 bootstrap: SAPUI5 1.136 from ui5.sap.com, Horizon theme
  webapp/manifest.json              app descriptor: routes (hash based), libraries
  webapp/Component.js
  webapp/view/*.view.xml            App (shell), Dashboard, Packages, Iflows, Generate, Monitor, Activity
  webapp/controller/*.controller.js
  webapp/fragment/                  dialogs
  webapp/util/                      api (REST client), formatter, markdown, flowDiagram, ExplainDialog
  webapp/css/style.css              small additions using Horizon theme parameters
app/router/                         standalone approuter (XSUAA login, serves the UI5 build, forwards /api)
server.js                           local: serves the UI5 app at "/"; CF/SQLite: deploys the in-memory schema
mta.yaml, mta-sqlite.yaml           Cloud Foundry deployment (HANA Cloud default, SQLite alternative)
xs-security.json                    XSUAA: scope Admin, role collection IntegrationPilot_Admin
```

## Setup

```bash
npm install
npm run ui:install       # UI5 Tooling and linter (only needed for build/lint)
npm run db:deploy        # creates db.sqlite (git-ignored) for the local profiles; run it again after schema changes
npm run groovy-check:build  # Groovy syntax check sidecar (needs JDK 17+ and Maven)
```

`.env` holds `LLM_MODEL` and `LLM_FALLBACK_MODEL`, plus optional `LLM_MAX_TOKENS` (default 8192;
large specs need more). Model answers are streamed: `LLM_IDLE_TIMEOUT_MS` (default 60000) is the
longest pause allowed in an answer and `LLM_TIMEOUT_MS` (default 900000) the cap for one model
call; `LLM_STREAM=false` switches streaming off for a provider that does not support it.
`AGENT_MAX_MODEL_CALLS` (default 20) caps the model calls per chat message; a 30-step flow with
scripts needs about 15. `AGENT_MAX_TOKENS_PER_MESSAGE` (default 300000) caps the tokens (input +
output) per message: the agent then stops with what is done and left, keeps the draft and the
scripts, and "continue" resumes. The Activity page shows how close requests come to the budget. `.cdsrc-private.json` binds the hybrid profile
to the destination service `iflowpilot-dest`. Both files were copied from iflow-pilot and are
git-ignored. See iflow-pilot's README for setting up the destinations `CPI_API` and `NVIDIA_LLM`.

## Run locally

Integration Pilot runs on **port 4005**, so it can run next to iflow-pilot (4004).

```bash
cf login -a https://api.cf.us10-001.hana.ondemand.com && cf target -o <org> -s <space>
npm run watch:hybrid     # CAP + UI5 app on http://localhost:4005
```

Open `http://localhost:4005/`. The UI5 app is served directly from `webapp/`: no build step,
and changes appear after a browser reload. If `app/integration-pilot/dist` exists (after
`npm run ui:build`), CAP serves the build instead; delete `dist` to go back to the sources.

**In SAP Business Application Studio:** when the port-4005 notification appears, choose *Open in a New
Tab*, or use the Command Palette → *Ports: Preview* → 4005.

Locally every request runs as `local-dev` with the `Admin` role (`srv/lib/dev-auth.js`).

**Groovy syntax check.** `validateSpec` sends every Groovy script (written or attached) to the
sidecar in `groovy-check/` (Groovy 4 parser, CONVERSION phase only: no SAP classpath, nothing is
executed, `@Grab` is off) and returns errors as `GROOVY_SYNTAX file:line:column: message`. Run it next
to the app with `npm run groovy-check` (port 4010) and set `GROOVY_CHECK_URL=http://localhost:4010`
in `.env`. Without it, scripts are proposed with a "not checked" warning; `GROOVY_CHECK_REQUIRED=true`
blocks proposals instead (set in the MTA files, where the sidecar is the module
`integration-pilot-groovy-check` with a generated shared token).

## Checks

```bash
npm test                 # backend: jest tests (validator, builder, parser, import, agent, proposals, LLM, Groovy check, prompt linter)
npm run test:ui          # UI: wdi5 tests of the Generate page in Chrome (app on port 4011 with the AI, CPI and Groovy check faked)
npm run ui:lint          # UI5 linter (deprecated APIs, manifest, best practices)
npm run ui:build         # UI5 build: Component-preload.js, minified sources in app/integration-pilot/dist
scripts/test-chat.sh     # live agent conversation via curl (default http://localhost:4005/api)
```

`npm run test:ui` starts the app itself (`test/ui/fake-backend.cjs`, in-memory database) and
drives it with WebdriverIO + wdi5 (`test/ui/wdio.conf.mjs`). WebdriverIO downloads a matching
Chrome unless `CHROME_BIN` (and `CHROME_VERSION`) point to one; `HEADED=1` shows the browser.
The UI5 runtime comes from ui5.sap.com, so the browser needs internet access (`HTTPS_PROXY` is
passed on). Screenshots of failing tests land in `test/ui/screenshots/`.

## Deploy to Cloud Foundry

The same setup as iflow-pilot, with Integration Pilot's own names:

- **`integration-pilot`:** the approuter. Users open this URL. It serves the UI5 build.
- **`integration-pilot-srv`:** the CAP backend. It uses the HANA Cloud HDI container
  `integration-pilot-db`, deployed by `integration-pilot-db-deployer`.
- **Shared:** the existing destination service `iflowpilot-dest`.

```bash
npm run build:mta && npm run deploy                  # HANA Cloud (instance must be running and mapped to the space)
# or
npm run build:mta:sqlite && npm run deploy:sqlite    # in-memory SQLite, demo only
```

After the first deployment, assign the role collection **`IntegrationPilot_Admin`** (BTP cockpit →
Security → Role Collections → `IntegrationPilot_Admin` → Edit → Users). Then log out and in again.

**Local hybrid run against HANA:**

```bash
cds bind -2 integration-pilot-db --for hybrid-hana
cds bind -2 iflowpilot-dest --for hybrid-hana
npm run watch:hana
```
