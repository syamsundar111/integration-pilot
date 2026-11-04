# Builder v2 plan

Builder v2 extends the iFlow builder beyond the linear spec v1 (one trigger, a straight list of
steps, one end), so the app can build flows like real ones: routers, splitters, process calls,
more adapters. Work happens on branch `builder-v2`. Rules for the work itself are in
[CLAUDE.md](../CLAUDE.md#working-agreements).

## How a component gets supported

1. A **reference export** in `srv/iflow-builder/reference/` contains it (built in the CPI editor, dummy data only;
   the first ones were built with the iGlow tool, then corrected and saved there), with its request in
   `test/reference-prompts/<name>.txt`.
2. Its XML becomes a template (`npm run templates:derive`); its dropdown values become the allowed
   values (`templates/reference-values.json`). When the phase starts, the values the user selected
   in the CPI editor for it go into `reference/confirmed-values.json` (then a value seen in only one
   reference does not warn). Values count as selected only when the user says so: for an export built
   from scratch in the CPI editor, every value; for a re-saved export (e.g. the Ref_Sender_SOAP
   re-export), only the values the user names.
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
| 3 | SOAP 1.x and Mail receivers (format below) | Ref_Receivers | done |
| 4 | Message Mapping: an existing artifact (a `PH_` placeholder if it does not exist) or a mapping inside the iFlow carried from Import; XSLT Mapping step (format below) | Ref_Mapping, MM_DummyOrderToNotif | done |
| 9 | Multicast and Join (format below) | Ref_Multicast | done |
| 5 | Senders (HTTPS, SOAP, ProcessDirect, SFTP, JMS) and the HTTP error response pattern (format below) | Ref_Sender_* | done (error response, SOAP, ProcessDirect, JMS; SFTP committed as e637698) |
| 6 | Receivers 2, in this order: ProcessDirect, SFTP, OData V2, IDoc, then the IDoc sender, JDBC, RFC. One small export per adapter, built from scratch in the CPI editor; the user makes each just before it starts, from a field-by-field checklist | Ref_Receiver_* and Ref_Sender_IDoc (new); Ref_Receivers_2 (iGlow) only for comparison | in progress: ProcessDirect receiver done (be6ce99); the SFTP receiver waits for its export |
| 6b | Content Enricher and Poll Enrich (they need phase 6's OData and SFTP adapters; neither real iFlow uses them) | Ref_Multicast_Enrich, to be re-selected first | after phase 6 |
| 6c | The OData V2 receiver of the HR cloud adapter (both real iFlows use it) | an export to come | after 6b |
| 7 | Persistence: Data Store, Idempotent Process Call, JMS (check transaction handling first, see Later) | Ref_Persistence | waits for the user's go |
| 8 | Transforms: XML Validator, Filter, CSV converters, encoders | Ref_Transform | waits for the user's go |

Order from here (the user's decision, 2026-11-02): phases 5, 6, 6b, 6c, 7 and 8, then the **acceptance test**: the first
full prompt from the start of the project, run through the app after the last phase.

## Prompt size (every phase)

A linear request must not pay for features it does not use. Each phase puts its AI rules into a topic
section (`srv/agent/prompt-sections/<topic>.md`, added by `agent.js` when the request's words or the
draft need it, sticky per conversation) and its step formats under the same topic in `getSupportedSteps`
(`tools.js` TOPICS; the model can also ask for a topic). The core prompt keeps one pointer line per
topic. Topics so far: `routing` (1b), `splitting` (2), `soap` and `mail` (3), `mapping` (4), `multicast` (9), `senders` (5). Measured on 2026-10-29 (scenario b, one live
run): 30k input tokens before, 25k after; largest prompt 12k -> 9k. A request that needs both topics
without their trigger words ("send every order separately; type A also goes to ...") fetched both
through `getSupportedSteps` and proposed a valid splitter with a router (25.6k input tokens).

## Open before a step can start

- **Confirmed values per phase** (add to `reference/confirmed-values.json` when the phase starts):
  in: phase 4's (static mapping reference; XSLT source inside the iFlow and output format Bytes), phase 3's (Mail: Plain User/Password, STARTTLS Mandatory, text/plain; SOAP: Basic, On-Premise), step c's (OAuth2 Client Credentials, On-Premise), 1a's
  (Global/Local Variable source types, Write Variables types, scopes and data type, timer every 15 minutes,
  Header and Property sources), 1b's (the expression type XML of the default route `R_Other`) and phase
  2's (re-selected in Ref_Structure, 2026-10-29: both splitters' expression type XPath, Parallel
  Processing off, Streaming (on in `ITSPL_Orders`, off in `GSPL_Orders`) and Stop On Exception (off in
  `ITSPL_Orders`, on in `GSPL_Orders`); the Gather
  `GA_Orders` with Same Format and Combine at XPath, `GA_Combine` with Same Format and Combine; the Looping Process Call's expression type Non XML).
  Not confirmed yet, so it warns: the Content Modifier data type java.lang.Boolean.
- **Phase 8:** Ref_Transform refers to `DummyItems.xsd` and `DummyItem.xsd`, which are missing in
  its ZIP. The XML Validator needs `.xsd` files as uploads, which are refused since phase 4.

## The branch format and how later phases fit it

Since 1b the spec is a main line of steps in which a step may hold nested step lists that either end or
continue with the next main-line step (a router's routes). Later phases use the same shape, so the
validator (step paths, names, the 50-step limit per process over its nested steps), the builder (a lane per nested
list, one column per node, receivers above the pool, below it for multicast branches) and import/update need no rework.

Phase 2 (format agreed 2026-10-29):

- **Splitter and Gather: flat.** A `splitter` is a plain main-line step, as CPI stores it: the steps
  after it run once per item until a `gather`, or to the end. Fields: `name`, `kind` (iterating |
  general), `expression` (XPath; the only expression type in the references), `grouping` (default 1),
  `streaming` (default on), `parallel` (off only) and `stopOnException`, which has no default: the AI
  always sets it, and the panel says it in plain words ("one failing item stops / does not stop the
  rest"). A `gather` with only `name` is Combine (XML Same Format; all 18 Gathers of the real iFlows); with
  `source` and `target` XPath it is Combine at XPath. The Different Format gathers of Ref_Multicast_Enrich
  come later, only from a re-selected export.
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
  warning. Each has its own 50-step limit, like the main flow (the real iFlows in test/local showed that a
  shared limit refuses large flows).
- **XML router notice:** the panel shows it for every XML router unless the step before it is known to
  produce XML (a JSON to XML converter); the tenant check showed it after a splitter too.
- **Process Call:** a `processCall` step with `name` and `process` (the local process's name), on the
  main line, inside a route, or in the exception subprocess (the original interface calls its local
  process from there: Error Start -> Process Call -> Escalation End). `loop: { condition, max }` makes
  it a Looping Process Call (Non-XML condition with spaces around the operator). Options are objects
  on the step, so phase 7's Idempotent Process Call fits as another option beside `loop`.

Not in 1b: routers inside routes (refused, Import makes them a placeholder). They fit the same shape and
come when a real interface needs them.

Phase 3 (format agreed 2026-10-30):

- **`requestReplySoap`:** a Request Reply with the SOAP 1.x adapter, without WSDL or operation (the
  original interface's channel uses none either; its WSDL file is only for its mapping). Basic and
  On-Premise only. Only the address can be a `{{Param}}`, as in Ref_Receivers.
- **`sendMail`:** a Send step with the Mail adapter, one-way. STARTTLS mandatory, Plain User/Password,
  text/plain and no attachments are fixed. Server, credential name and recipients can be a `{{Param}}`.
- **Where:** both on the main line, in routes and in local processes; `sendMail` also in the exception
  subprocess, its receiver right below the main pool. No SOAP or Mail receiver at the end of a flow.

Phase 4 (format agreed 2026-10-30):

- **`messageMapping`:** `mapping` is an artifact's id, checked on the tenant at proposal time
  (`MessageMappingDesigntimeArtifacts`): missing is refused and the AI puts a `PH_` placeholder there;
  another package gives a note, since it is not known whether the editor lists those. The artifact must
  be deployed before the iFlow runs. Or `file` with `schemas`: a mapping inside the iFlow, as all 16 Message
  Mappings of the real iFlows; carried from Import or an existing iFlow, never written by the AI.
- **`xsltMapping`:** `file` is an attached `.xsl`; the AI never writes XSLT. `resources` stays for XSLT
  files no step uses.
- **Where:** the main line, routes, local processes and the exception subprocess.
- **Files:** `.mmap`, `.xsd` and `.wsdl` can only come from an iFlow. Files from an iFlow have a limit of
  200 per conversation, uploads and written scripts 20.
- **Panel note, as confirmed in the tenant check:** CPI's notice says XML or JSON input on a Message
  Mapping and XML input on an XSLT Mapping; the note stays "may".

Phase 9 (format agreed 2026-10-30, branch contents decided by the tenant experiment in Ref_Multicast):

- **`multicast`:** `{ name, mode: parallel | sequential, join, branches: [{ name, steps }] }` with 2-20 branches of
  at least one step. The builder adds the Join (`join` is its name), and the next step must be a `gather` with
  only a name: Combine, XML Same Format. Different Format comes later, only from a re-selected export.
- **Where:** the main line only. Not in a route, a branch, a local process or the exception subprocess (no
  reference has one there). The shape of a real iFlow with an SFTP sender, a router choosing between two multicasts that share 14 branches, is
  a graph, not a tree: Import keeps its main path with placeholders.
- **Branches:** plain steps, process calls and routers; every branch reaches the Join. **In a branch one route of a
  router continues and the others end:** with two continuing routes that joined again at a step in the branch, CPI
  marked the Join with "Multicast does not exist for join" (tenant check, 2026-10-30), and the warning went away when
  one of them ended. Import makes such a router a placeholder, and an update is blocked. To join routes again, route
  inside a local process called with a Process Call: CPI checks a local process as its own process (Ref_Structure's
  `LIP_HandleOrder`, called per item, has two routes that join again, without a warning).
  **A router before a gather is refused**, in a branch even before the splitter: in Ref_Multicast CPI marks
  `GA_Items` with "You cannot use Router with gather; use gather after splitter or join", even when only one route
  reaches it. A split in a branch is closed by a gather there (CPI: "always use gather in between splitter - join")
  and routes per item through a Process Call to a local process, as in phase 2.
- **Layout:** receivers of steps in a branch sit below the pool, as for local processes; a line up would cross the
  branches above. A line down can still cross the lanes of later branches, or an exception subprocess in that column.
- **Ref_Multicast's `RT_Item` is kept as exported:** the reference shows the shapes and values; its own branch is a
  shape the spec refuses, so an update of it is blocked and Import makes the splitter and the gather placeholders.

Phase 5 (format agreed 2026-11-02, one sender per task):

- **Error response to an HTTPS sender**, only when the user asks for one: a Message End, and a Content Modifier with
  `CamelHttpResponseCode` and a `Content-Type` that matches the body (Ref_Sender_HTTPS). Default: Escalation End.
- **Senders in `trigger`**, like `httpsSender`; the default stays `httpsSender`. Their AI rules are in the topic
  section `senders`. Import and update keep a sender only when the spec holds it exactly, including which fields
  are parameters (`sender-settings.js`); else Import makes it HTTPS with a note, and an update is blocked.
- **`soapSender { address }`:** SOAP 1.x, Manual (no WSDL; the URL cleared in the re-export), Request-Reply, User
  Role `ESBMessaging.send`. XML in and out: the body is the content of the SOAP body, and the body at the end is the
  response. The endpoint URL is not shown until the user has seen it after a deployment.
- **`processDirectSender { address }`:** only the address, no authentication (Ref_Sender_ProcessDirect). The caller
  side, a ProcessDirect receiver, comes in phase 6; until then, for "one iFlow calls another", the caller gets a
  `PH_` placeholder where the call goes (the `processDirect` pattern), and the HTTPS workaround only on request.
- **`jmsSender { queue }`:** the queue name the user gives (never invented); retry fixed as re-selected in Ref_Sender_JMS
  (1 minute, exponential backoff, at most 60 minutes), dead-letter queue on. With an exception subprocess the AI ends
  it with an Error End, so a failed message is retried. The queue is created on the first deployment (SAP Help); the
  JMS receiver that fills it comes in phase 7. Transaction handling stays Not Required, as in every export.
- **`sftpSender { host, directory, fileName, authentication, postProcessing, minutes }`:** from Ref_Sender_SFTP_UserPw
  (Ref_Sender_SFTP has the public-key variant). `authentication` `publicKey` with `username` and `privateKeyAlias`, or
  `userPassword` with `credentialName`; `postProcessing` `delete`, or `move` with `archiveDirectory`; `minutes` only as
  in the references (15; the scheduler is UserPw's: daily, every 15 minutes, 00:00-24:00, Etc/GMT). Host, directory,
  file name, credential name and archive directory can be a whole parameter, as the export has them; user name and
  key alias are literal. Proxy Internet, read lock none, empty files processed, 20 files per poll, as exported. The AI
  asks for host, directory, file name and authentication, and whenever it asks, also "delete or move?" (else delete,
  said in one line); its summary always says what happens to the files, and ends an exception subprocess with an Error End. The panel says the host key must be
  in the tenant's known hosts (and, for public key, that the key alias must be a key pair the server accepts).

## Phase 6 format

- **`requestReplyProcessDirect { address, system? }`** (a step: main line, routes, branches, local processes; not the
  exception subprocess) and the end **`processDirectReceiver { address, system? }`** (a Message End), from
  Ref_Receiver_ProcessDirect. The address is the called iFlow's ProcessDirect sender address, or a whole parameter with
  the parameter reference as the editor writes it. The `processDirect` pattern builds the call instead of a `PH_`
  placeholder. Import and update keep both exactly; Import and update also recognise a placeholder again by its
  `REPLACE_WITH` property (the description is not in the iFlow).

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
- Gather Combine: confirm the output on a deployed run (the panel says the items "may" sit in a
  multi-mapping envelope), then make the note definite or remove it.
- Proposal panel, diagram summary: show the Escalation End category on the route lines and the "On error"
  line, as the step cards do.
- Looping Process Call: "Action when Max. Iterations Reached" is fixed to Throw Exception (as in
  Ref_Structure); add End Loop as a choice when a real interface needs it.
- Escalation and Error End in local processes (needs a reference export).
- Multicast in a local process (needs a reference export).
- SFTP sender: authentication, post-processing and the scheduler as externalized parameters (a real iFlow with an
  SFTP sender has them so); needs an export that externalizes them. Until then Import keeps such a sender only as
  HTTPS, with a note, and an update is blocked.
- Diagram layout (cosmetic): a Request Reply's receiver sits above the pool, and its adapter label (e.g.
  "ProcessDirect") overlaps the pool title "Integration Process".
- ProcessDirect receiver at the end: confirm on a deployed run whether the caller waits until the called iFlow has
  finished (the panel says "may").
- JMS and SFTP senders: confirm on a deployed run how JMS retry and SFTP file handling behave when the exception
  subprocess ends with a Message End, an Escalation End and an Error End (the panel says "may" until then).
- ProcessDirect: confirm on a deployed run that headers and the body reach the called iFlow and exchange properties
  do not (the panel says "may not"), and that a second iFlow with the same ProcessDirect address fails to deploy
  (the panel says "may").
- Import, at the latest with phase 6: recognise a `PH_` Content Modifier with a `REPLACE_WITH` property as a
  placeholder again (a step's description is not written into the iFlow), so an imported caller still shows that its
  ProcessDirect call is missing.
- JMS queue names: the rule (letters, digits, `_ - .`, up to 80 characters, no parameters) is not confirmed against
  CPI; only `DUMMY_QUEUE_IN` is in an export.
- SFTP sender values: the rules for host (`host` or `host:port`; CPI is expected to use 22 without a port), directory
  (letters, digits, `_ . ~ - /`), file name (letters, digits, `_ . - * ?`), user name, key alias and credential name
  are not confirmed against CPI; the exports have only `sftp.example.com:22`, `/dummy/in` and `*.xml`.
- Transaction handling with a JMS sender: nothing for the JMS sender alone (every export says Not Required); check it
  again in phase 7, where a JMS receiver and a Data Store may need "Required for JMS" (Ref_Persistence also says Not
  Required).
- HTTP error response: an exception message with quotes or line breaks makes the JSON error body
  `{"error": "${exception.message}"}` invalid.
- Multicast: a router before a splitter in a branch, its own tenant test. It is refused today, but CPI's message only
  covers a router between a splitter and its gather.
- Multicast: confirm on a deployed run whether exchange properties set in a branch reach the steps after the Join
  (the panel says "may not"), and how the branch output is combined.
- Multicast layout: receiver lines can still cross, with receivers in several branches (the lanes of the later
  branches) or with an exception subprocess in the same column.
- SOAP receiver: Internet, no authentication, a WSDL with service, port and operation (needs `.wsdl` and
  its `.xsd` files as uploads, refused since phase 4); the credential name and location ID as parameters.
- Mail: other protection, authentication and body types, attachments; a mail or SOAP receiver at the end.
- From real iFlows (test/local/real-iflows/NOTES.txt): exception subprocesses inside local processes; a
  Send step with an SFTP receiver. (The OData V2 receiver of the HR cloud adapter is phase 6c.)
- Message Mapping `MM_DummyOrderToNotif`: not on the re-provisioned tenant (2026-11-04); re-import or rebuild it before
  a chat test or the acceptance test uses it.
- OData V4 receiver: needs an export built in the CPI editor (Query (GET), resource path, query options, Basic,
  Internet); no real iFlow uses it.
- More timer schedules: every N hours, daily, weekly and monthly at a time, other time zones, and the
  scheduler externalized as `{{Scheduler}}`.

Credential names in references are dummy aliases: saving an iFlow does not check them (deploying does),
so they need not exist in Security Material. Never enter real credentials in a reference.
