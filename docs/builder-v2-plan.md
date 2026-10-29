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
   values (`templates/reference-values.json`).
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
| c | HTTP receiver: authentication (None, Basic, OAuth2 Client Credentials) with credential name, proxy Internet / On-Premise with location ID, timeout | Ref_Receivers | waiting for the tenant check |
| c2 | Credential name and location ID as externalized parameters, with the regression test update | Ref_Receivers (new version: RR_OAuth's credential name and RR_OnPrem's location ID externalized) | after c |
| 1 | Router with conditions and default route; Message, Escalation and Error End; Write Variables; Content Modifier sources (Global/Local Variable, Header, Property, XPath); Timer start with a schedule (every N minutes) | Ref_Router_Ends, Ref_Variables | open |
| 2 | General and Iterating Splitter, Gather; local integration process with Process Call and Looping Process Call | Ref_Structure | open |
| 3 | SOAP 1.x and Mail receivers | Ref_Receivers | open |
| 4 | Message Mapping that refers to an existing mapping artifact (a `PH_` placeholder if it does not exist); XSLT Mapping step | Ref_Mapping, MM_DummyOrderToNotif | open |
| 5 | Senders (HTTPS, SOAP, ProcessDirect, SFTP, JMS) and the HTTP error response pattern | Ref_Sender_* | waits for the user's go |
| 6 | Receivers 2: OData V2, RFC, IDoc, SFTP, JDBC, ProcessDirect | Ref_Receivers_2 | waits for the user's go |
| 7 | Persistence: Data Store, Idempotent Process Call, JMS | Ref_Persistence | waits for the user's go |
| 8 | Transforms: XML Validator, Filter, CSV converters, encoders | Ref_Transform | waits for the user's go |
| 9 | Multicast, Join, Content Enricher, Poll Enrich | Ref_Multicast_Enrich | waits for the user's go |

## Open before a step can start

- **Step c2:** the new Ref_Receivers (the user replaces it after step c is committed); until then a
  credential name or location ID must be literal.
- **Phase 2:** re-select the Gather values of `GA_Orders` in Ref_Structure in the CPI editor
  (Ref_Multicast_Enrich's Gathers matter only for phase 9).
- **Phase 3:** check whether `RR_S4HANA` in the original iFlow uses a WSDL; if so, add a WSDL variant
  to Ref_Receivers (today: no WSDL, no operation name).
- **Phase 8:** Ref_Transform refers to `DummyItems.xsd` and `DummyItem.xsd`, which are missing in
  its ZIP.

## Later (no phase yet)

From the former reference export checklist; each needs a reference export first.

- Receiver authentication **OAuth2 SAML Bearer Assertion** and **Client Certificate** (private key alias).
- More timer schedules: every N hours, daily, weekly and monthly at a time, other time zones, and the
  scheduler externalized as `{{Scheduler}}`.

Credential names in references are dummy aliases: saving an iFlow does not check them (deploying does),
so they need not exist in Security Material. Never enter real credentials in a reference.
