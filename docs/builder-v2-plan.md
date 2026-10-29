# Builder v2 plan

Builder v2 extends the iFlow builder beyond the linear spec v1 (one trigger, a straight list of
steps, one end), so the app can build flows like real ones: routers, splitters, process calls,
more adapters. Work happens on branch `builder-v2`. Rules for the work itself are in
[CLAUDE.md](../CLAUDE.md#working-agreements).

## How a component gets supported

1. A **reference export** in `srv/iflow-builder/reference/` contains it (built with iGlow, then
   corrected and saved in the CPI editor, dummy data only), with its request in
   `test/reference-prompts/<name>.txt`.
2. Its XML becomes a template (`npm run templates:derive`); its dropdown values become the allowed
   values (`templates/reference-values.json`). When the phase starts, the values the user re-selected
   in the CPI editor for it go into `reference/confirmed-values.json` (then a value seen in only one
   reference does not warn).
3. Spec schema, validator, builder, parser, update (`to-spec.js`) and import support it; the AI
   instructions, the pre-send check and [prompt-guide.md](prompt-guide.md) say so.
4. **Offline regression test:** a spec written from the reference's prompt is built, parsed and
   compared with the parsed reference (`test/reference-regression.test.js`).
5. **Tenant check:** the user creates a test iFlow on the tenant and opens it in the CPI editor.
   Only then is the step committed.

Live runs of the reference prompts through the agent happen only on demand, with a token limit per
prompt and the tokens used reported per prompt.

## Steps and phases

| Step | Scope | References | Status |
|---|---|---|---|
| a | Commit the open work on `main`, branch `builder-v2`, references and prompts | all | done |
| b | Parser: the main process is the process that is not local | Ref_Structure | done |
| c | HTTP receiver: authentication (None, Basic, OAuth2 Client Credentials) with credential name, proxy Internet / On-Premise with location ID, timeout | Ref_Receivers | done |
| c2 | Credential name and location ID as externalized parameters, with the regression test update | Ref_Receivers (new version: RR_OAuth's credential name and RR_OnPrem's location ID externalized) | done |
| 1a | No change to the flow structure: Content Modifier sources (Global/Local Variable, Header, Property, XPath with data type), a constant as an externalized parameter, the Default column; Write Variables (global and local scope); Timer start every N minutes (UTC) | Ref_Variables, Ref_Router_Ends (timer) | done |
| 1b | Branching: Router with conditions and a default route; routes that end (Message, Escalation or Error End) or join again; Error and Escalation End in the exception subprocess (format agreed, see below) | Ref_Router_Ends | done |
| 2 | General and Iterating Splitter, Gather; local integration process with Process Call and Looping Process Call | Ref_Structure | done |
| 3 | SOAP 1.x and Mail receivers | Ref_Receivers | open |
| 4 | Message Mapping that refers to an existing mapping artifact (a `PH_` placeholder if it does not exist); XSLT Mapping step | Ref_Mapping, MM_DummyOrderToNotif | open |
| 5 | Senders (HTTPS, SOAP, ProcessDirect, SFTP, JMS) and the HTTP error response pattern | Ref_Sender_* | waits for the user's go |
| 6 | Receivers 2: OData V2, RFC, IDoc, SFTP, JDBC, ProcessDirect | Ref_Receivers_2 | waits for the user's go |
| 7 | Persistence: Data Store, Idempotent Process Call, JMS | Ref_Persistence | waits for the user's go |
| 8 | Transforms: XML Validator, Filter, CSV converters, encoders | Ref_Transform | waits for the user's go |
| 9 | Multicast, Join, Content Enricher, Poll Enrich | Ref_Multicast_Enrich | waits for the user's go |

## Prompt size (every phase)

A linear request must not pay for features it does not use. Each phase puts its AI rules into a topic
section (`srv/agent/prompt-sections/<topic>.md`, added by `agent.js` when the request's words or the
draft need it, sticky per conversation) and its step formats under the same topic in `getSupportedSteps`
(`tools.js` TOPICS; the model can also ask for a topic). The core prompt keeps one pointer line per
topic. Topics so far: `routing` (1b) and `splitting` (2). Measured on 2026-10-29 (scenario b, one live
run): 30k input tokens before, 25k after; largest prompt 12k -> 9k. A request that needs both topics
without their trigger words ("send every order separately; type A also goes to ...") fetched both
through `getSupportedSteps` and proposed a valid splitter with a router (25.6k input tokens).

## Open before a step can start

- **Confirmed values per phase** (add to `reference/confirmed-values.json` when the phase starts):
  phase 3: the Mail values in Ref_Receivers. In: step c's (OAuth2 Client Credentials, On-Premise), 1a's
  (Global/Local Variable source types, Write Variables types, scopes and data type, timer every 15 minutes,
  Header and Property sources), 1b's (the expression type XML of the default route `R_Other`) and phase
  2's (re-selected in Ref_Structure, 2026-10-29: both splitters' expression type XPath, Parallel
  Processing off, Streaming (on in `ITSPL_Orders`, off in `GSPL_Orders`) and Stop On Exception (off in
  `ITSPL_Orders`, on in `GSPL_Orders`); the Gather
  `GA_Orders` with Same Format and Combine at XPath; the Looping Process Call's expression type Non XML).
  Not confirmed yet, so it warns: the Content Modifier data type java.lang.Boolean.
- **Phase 3:** check whether `RR_S4HANA` in the original iFlow uses a WSDL; if so, add a WSDL variant
  to Ref_Receivers (today: no WSDL, no operation name).
- **Phase 8:** Ref_Transform refers to `DummyItems.xsd` and `DummyItem.xsd`, which are missing in
  its ZIP.

## The branch format and how later phases fit it

Since 1b the spec is a main line of steps in which a step may hold nested step lists that either end or
continue with the next main-line step (a router's routes). Later phases use the same shape, so the
validator (step paths, names, the 50-step count over all nested steps), the builder (a lane per nested
list, one column per node, receivers above the pool) and import/update need no rework.

Phase 2 (format agreed 2026-10-29):

- **Splitter and Gather: flat.** A `splitter` is a plain main-line step, as CPI stores it: the steps
  after it run once per item until a `gather`, or to the end. Fields: `name`, `kind` (iterating |
  general), `expression` (XPath; the only expression type in the references), `grouping` (default 1),
  `streaming` (default on), `parallel` (off only) and `stopOnException`, which has no default: the AI
  always sets it, and the panel says it in plain words ("one failing item stops / does not stop the
  rest"). A `gather` has `name`, `source` and `target` XPath (XML Same Format, Combine at XPath; the
  Different Format gathers of Ref_Multicast_Enrich come with phase 9).
- **Main line only.** Splitters and gathers sit on the main line; a gather needs a splitter before it;
  a second splitter between a splitter and its gather (nested split) is refused with a clear message.
  So is a router between them (tenant check: CPI says "You cannot use Router with gather"); the message
  suggests a Process Call per item to a local process that contains the router. A router after a
  splitter that runs to the end (no gather) is fine.
- **Information note** (panel and prompt guide): exchange properties set while processing one item do
  not reach the steps after the Gather; results must travel in the message body.
- **Local processes:** a top-level `localProcesses: [{ name, steps }]`, each in its own pool below the
  main pool. Their steps are the existing step types and routers (the main-line router rules; no nested
  routers; a route continues or ends with the local process's plain End, the only end event the
  references have there; that End returns to the caller, the flow goes on after the Process Call), without splitters and process calls. A local process nothing calls gives a
  warning. Their steps count towards the 50-step limit.
- **XML router notice:** the panel shows it for every XML router unless the step before it is known to
  produce XML (a JSON to XML converter); the tenant check showed it after a splitter too.
- **Process Call:** a `processCall` step with `name` and `process` (the local process's name), on the
  main line, inside a route, or in the exception subprocess (the original interface calls its local
  process from there: Error Start -> Process Call -> Escalation End). `loop: { condition, max }` makes
  it a Looping Process Call (Non-XML condition with spaces around the operator). Options are objects
  on the step, so phase 7's Idempotent Process Call fits as another option beside `loop`.
- **Multicast and Join (phase 9):** a `multicast` step like a router without conditions: `branches`
  that all run, and join again at the step after it (with a Gather).

Not in 1b: routers inside routes (refused, Import makes them a placeholder). They fit the same shape and
come when a real interface needs them.

## Later (no phase yet)

From the former reference export checklist; each needs a reference export first.

- Receiver authentication **OAuth2 SAML Bearer Assertion** and **Client Certificate** (private key alias).
- Proposal panel: show the effective proxy and timeout of every receiver, with defaults marked as such
  ("Internet (default)", "60000 ms (default)"); today they appear only when they differ from the default.
- Proposal panel, credentials note: for a credential given as a parameter, name the credential that must
  exist, e.g. "DUMMY_OAUTH_CRED (parameter OAuthCredential)", not "{{OAuthCredential}}" (the chat answer
  already does this).
- Escalation End: the receiver categories (Receiver not reachable, Receiver not found, Not authenticated,
  Not authorized, Receiver tries to redirect, Internal server error in receiver); today Others and
  Routing condition not met.
- Proposal panel, diagram summary: show the Escalation End category on the route lines and the "On error"
  line, as the step cards do.
- User-facing notes: phrase them without the builder version ("For a method v1 does not set…").
- Looping Process Call: "Action when Max. Iterations Reached" is fixed to Throw Exception (as in
  Ref_Structure); add End Loop as a choice when a real interface needs it.
- Escalation and Error End in local processes (needs a reference export).
- More timer schedules: every N hours, daily, weekly and monthly at a time, other time zones, and the
  scheduler externalized as `{{Scheduler}}`.

Credential names in references are dummy aliases: saving an iFlow does not check them (deploying does),
so they need not exist in Security Material. Never enter real credentials in a reference.
