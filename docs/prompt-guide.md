# Writing requests for Integration Pilot

Integration Pilot turns a chat request into an iFlow proposal. A request that gives the
assistant everything up front gets a proposal in one turn. A request that leaves things
open costs extra rounds of questions, and every round re-sends the whole conversation to the
model. This guide shows how to write requests that work the first time, with three worked
examples against public test APIs: a small flow, a larger orchestration, and the rebuild of an
existing iFlow with placeholders.

## What v1 can build

The assistant can only propose what the builder can build. Anything else fails validation or
turns into extra questions.

| | Supported | Not supported |
|---|---|---|
| Trigger | HTTPS sender (with a path), timer that runs once after deployment | Schedules, SFTP, SOAP, other senders |
| Steps | Content Modifier, Groovy Script, JSON to XML, XML to JSON, HTTP request-reply | Router, splitter, gather, join, multicast, mapping, XSLT step, write variables, process call |
| End | HTTP receiver, or no receiver | Mail, SFTP and other receivers |
| Error handling | One exception subprocess (Content Modifier, Groovy, converters) | Request-reply inside the exception subprocess |

Hard limits:

- At most **50 steps** in the main flow (10 in the exception subprocess). Large flows are written
  and checked in parts of up to 8 steps, so their size does not cause timeouts.
- Step names, receiver names and Groovy file names must be **unique**.
- `{{Parameter}}` only as the **whole URL** of an HTTP receiver.
- Header and property values are **constant** or **expression** only. Read XML values with XPath in a
  Groovy script.
- Receivers are created with **no authentication**. You set the method and credential in the CPI
  web editor after creation.

## Start from the template

On an empty chat, choose **Start from the request template**. It fills the input with one line
per thing the assistant needs:

```text
Create an iFlow.
Trigger: <timer, run once after deployment — or HTTPS sender with path, e.g. /orders/create>
Steps (in order, at most 50):
1. <step type and name, e.g. Content Modifier "Set Properties": property Source = constant Shop>
2. <…>
Receivers: <name, method and URL of each HTTP call; externalize a URL as {{Name}} with a default>
Authentication: <None, or method and credential name per receiver>
Package: <existing package id, or a new id (letters, digits, dots) and name>
Error handling: <exception subprocess: what to set, log or return when a step fails>
```

Before sending, the chat checks the request without calling the model. It warns about:

- a missing package, trigger or authentication (unless set in the session defaults)
- steps v1 cannot build (router, splitter, gather, join, multicast, XSLT, mapping, SFTP, write variables, process call)
- more than 25 numbered steps
- `{{…}}` used anywhere other than a URL
- template fields that are still unfilled

Choose **Edit** to fix the request, or **Send anyway**.

## Set the session defaults

Open **Session defaults** above the input and set:

- **Target package**: the package id. It is used as the spec's package.
- **Trigger**: *Timer, run once after deployment*, if that is the trigger.
- **Receiver authentication**: what you will configure after creation, for example
  *OAuth2 Client Credentials with credential DEMO_OAUTH on all receivers*.

They are sent with every message as structured context, and the assistant does not ask about
them again.

## Attach scripts instead of describing them

Every Groovy script, written by the assistant or attached, is syntax-checked before it can be
proposed; errors come back with file, line and column. Scripts the assistant writes are stored as
files of the conversation (shown as "written by the assistant" above the input), not inside the spec.

Describing a long Groovy script in prose is the most expensive thing a request can contain.
The model has to write the whole script into the spec, which is slow, can time out, and is
repeated whenever the spec is revised. If you have the script, attach it:

1. Choose the paperclip next to the input and pick the `.groovy` file. Its name becomes the
   script's file name, so name it like `mapUsers.groovy`.
2. In the request, refer to it by name: *Groovy Script "Map Users" using mapUsers.groovy*.

The model sees only the file name and size, never the content. The builder puts the file into
the iFlow. `.xsl` files can be attached too. They are added as `mapping/<file>`, ready for an
XSLT Mapping step that you add in the CPI web editor (v1 has no XSLT step).

## Import an existing iFlow

**Import iFlow** takes a `.zip` export or a `.iflw` file and turns it into the conversation's draft
spec:

- Steps v1 cannot build become placeholder Content Modifiers whose description says
  *REPLACE WITH …*, one per CPI component. Only if the flow would exceed 50 steps are consecutive
  placeholders merged.
- A branching flow keeps its main path (at each router, the route with a condition); the other
  routes are described in the router's placeholder.
- `{{Param}}` values outside receiver URLs become the parameter's default; a receiver URL combined
  from parameters becomes one `<Receiver>_URL` parameter.
- A Process Call in the exception subprocess is replaced by the steps of the local process it calls,
  if they are Content Modifiers and Groovy scripts.
- The import gets a new iFlow id (`<original>_Imported`); duplicate names are made unique.
- XPath values of Content Modifiers move into a generated Groovy script.
- Scripts and XSLT files become attachments.

Then ask *Propose the imported iFlow as a new iFlow* and replace the placeholders in the CPI web
editor after creation.

## Worked example 1: a small flow (Users Summary)

Read users and todos from the public test API `jsonplaceholder.typicode.com`, count the open todos
per user in Groovy, and convert the result to XML. `RUNID` stands for a unique suffix (the
measurement script replaces it); use your own ID and name.

### The first request

The first version is in
[scripts/measure/users-summary-request.md](../scripts/measure/users-summary-request.md). It is
precise about the flow, but two things make it more expensive than it needs to be:

1. **No package and no authentication.** The pre-send check warns about both; sent anyway, the
   assistant asks, which costs one extra round.
2. **Both Groovy scripts are described in prose.** The model has to write them, check them and keep
   them in the conversation.

### The improved request

1. Set the session defaults: target package `IntegrationPilot.Demo`, timer run once after deployment,
   and the receiver authentication note (here: none needed).
2. Attach the two scripts `summarizeUsers.groovy` and `buildErrorMessage.groovy` (both are in
   [test/fixtures/users-summary/](../test/fixtures/users-summary/)).
3. Send the request, which no longer describes the scripts:

<!-- example:improved-request -->
```text
Create an iFlow.
Name: Users Summary RUNID
ID: Users_Summary_RUNID
Purpose: read users and their todos from a REST API, summarize the open todos per user and convert
the summary to XML for a reporting system.
Steps (in order):
1. Content Modifier "Set Properties", constant properties:
   sourceSystem = JSONPlaceholder, targetSystem = Reporting, reportName = Users Summary,
   environment = DEV, alertTo = alerts@example.com, alertFrom = noreply@example.com
2. Request-reply "Get Users": GET, receiver RCVR_Users, URL {{Users_URL}}, default
   https://jsonplaceholder.typicode.com/users
3. Content Modifier "Store Users": property UsersJson = expression ${in.body}
4. Request-reply "Get Todos": GET, receiver RCVR_Todos, URL {{Todos_URL}}, default
   https://jsonplaceholder.typicode.com/todos
5. Content Modifier "Store Todos": property TodosJson = expression ${in.body}
6. Groovy Script "Summarize Users" using the attached summarizeUsers.groovy
7. JSON to XML Converter "Summary to XML"
No receiver at the end.
Error handling: exception subprocess "Exception Subprocess 1" with
- Content Modifier "Set Error Properties": ErrorMessage = expression ${exception.message},
  ErrorTimestamp = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}
- Groovy Script "Build Error Message" using the attached buildErrorMessage.groovy
Give every step a one-sentence description of its purpose.
```

The prompt check passes with the defaults set, and the model has nothing to ask and no script to
write. The expected spec is
[test/fixtures/users-summary/spec.json](../test/fixtures/users-summary/spec.json): 7 steps, 2
externalized URLs, an exception subprocess with 2 steps, and the two scripts as attached files.
`test/prompt-guide.test.js` checks this example: the linter result, the validation and build of the
spec with the attached scripts, and an import of the built iFlow back into the same spec.

## Worked example 2: a larger orchestration (Customer Activity Digest)

An HTTPS-triggered flow that calls the test API four times with Groovy between the calls, posts the
result to `https://httpbin.org/post`, and answers the caller. Everything is given up front: package,
trigger, authentication, numbered steps with names, every URL as a parameter with a default, and the
error handling, so the pre-send check passes without session defaults.

<!-- example:orchestration-request -->
```text
Create an iFlow.
Name: Customer Activity Digest RUNID
ID: Customer_Activity_Digest_RUNID
Package: PilotReference
Trigger: HTTPS sender, address /pilot/activity-digest-RUNID
Authentication: no authentication on any receiver.
Purpose: for the user id in the request, collect profile, posts, comments and todos from a REST API,
build one activity digest, send it to a target endpoint and answer the caller with a short status.

Steps (in order):
1. Content Modifier "Set Properties": property sourceSystem = constant JSONPlaceholder, property targetSystem = constant DigestService, property receivedAt = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}
2. Groovy Script "Read Request": parse the JSON body; throw an exception if userId is missing or not a number; set property userId.
3. Request-Reply "Get Users": GET, receiver RCVR_Users, URL {{Users_URL}}, default https://jsonplaceholder.typicode.com/users
4. Groovy Script "Pick User": from the JSON array keep the user whose id equals property userId; throw an exception if there is none; set property UserJson to that user as JSON.
5. Request-Reply "Get Posts": GET, receiver RCVR_Posts, URL {{Posts_URL}}, default https://jsonplaceholder.typicode.com/posts
6. Groovy Script "Filter Posts": keep the posts whose userId equals property userId; set property PostsJson (JSON array) and property PostCount.
7. Request-Reply "Get Comments": GET, receiver RCVR_Comments, URL {{Comments_URL}}, default https://jsonplaceholder.typicode.com/comments
8. Groovy Script "Count Comments": count the comments per postId for the posts in PostsJson; set property CommentCountsJson ({"<postId>": <count>}).
9. Request-Reply "Get Todos": GET, receiver RCVR_Todos, URL {{Todos_URL}}, default https://jsonplaceholder.typicode.com/todos
10. Groovy Script "Build Digest": body = JSON {"user": {id, name, email, company: company.name}, "posts": [{id, title, comments}], "openTodos": number of todos of the user with completed false, "generatedAt": property receivedAt}.
11. Content Modifier "Set Target Headers": header Content-Type = constant application/json, header X-Source = expression ${property.sourceSystem}
12. Request-Reply "Send Digest": POST, receiver RCVR_DigestService, URL {{DigestService_URL}}, default https://httpbin.org/post
13. Groovy Script "Build Reply": body = JSON {"status": "sent", "userId": <userId>, "posts": <PostCount>}; header Content-Type = application/json.
No receiver at the end: the reply goes back to the HTTPS caller.
Error handling: exception subprocess with
- Content Modifier "Set Error Reply": header CamelHttpResponseCode = constant 500, header Content-Type = constant application/json
- Groovy Script "Build Error Reply": body = JSON {"status": "failed", "error": ${exception.message}}.
```

What to expect: the assistant writes the 7 Groovy scripts with `writeScript`, then proposes the
13-step spec in one call. The exception subprocess returns HTTP 500 with a JSON error to the caller.

## Worked example 3: rebuild an existing iFlow with placeholders (25 steps, 8 placeholders)

An existing iFlow uses steps v1 cannot build: routers, a General Splitter, a Message Mapping, a SOAP
request-reply and Write Variables. This request rebuilds it step by step and keeps the interfaces
unchanged. Each unsupported component becomes a placeholder Content Modifier (`PH_...`) whose
description says exactly what to add in the CPI web editor; where two unsupported components follow
each other, one placeholder describes both (`PH_Router_MappingCheck_RR_TargetERP`). XPath values are
read in Groovy instead, and the original Groovy scripts are written from their descriptions. The
systems are generic: "Source System" (a REST API at `source.example.com`) and "Target ERP" (a SOAP
service at `erp.example.com`).

<!-- example:placeholder-rebuild-request -->
```text
Build this iFlow exactly as listed. Do not ask questions, do not rename, merge, add or remove steps.
Steps called PH_... are placeholder Content Modifiers with no rows; put the given text in their description.
Write each Groovy script from its description: import com.sap.gateway.ip.core.customdev.util.Message,
define def Message processData(Message message), null-safe, no external libraries, declare all variables
with def, do not change the body unless stated. Validate, then propose.

iFlow name: Source Records to Target ERP RUNID
iFlow ID: Source_Records_to_Target_ERP_RUNID
Package: PilotReference. Trigger: timer, run once (description: "Manual: schedule {{Scheduler}}, every 5 minutes").
All HTTP receivers authType None. End: none.

Main flow (25 steps):
1. contentModifier "CM_SetProperties". Properties (constant): AttachmentName = Source_Records_Response;
PayloadLogging = TRUE; QueryDate_Const = ""; QueryDate = "".
Description: "Manual: QueryDate type = persisted variable lastRunTime".
2. groovyScript "Script_SetLastRunTime", fileName Script_SetLastRunTime.groovy.
Code: property LastQueryDate = QueryDate_Const if not empty, else QueryDate if not empty,
else "1970-01-01T00:00:00.000Z".
3. requestReplyHttp "RR_Source_Records", system RCV_SOURCE_SYSTEM, GET, url {{Source_Records_URL}},
default: https://source.example.com/api/records?changed_since=${property.LastQueryDate}&fields=id,status,title,region_north,region_south,category,assigned_group,description,created_on
Description: "Manual: OAuth2 Client Credentials, credential SOURCE_OAUTH_CLIENT, timeout 60000".
4. groovyScript "Script_CheckEmpty", fileName Script_CheckEmpty.groovy.
Code: parse body as JSON; property HasRecords = "true" if "records" is a non-empty list, else "false".
5. PH "PH_Router_HasRecords": "REPLACE WITH Router 'Router Has Records': Route 1 Non-XML ${property.HasRecords} = 'true' continues;
Route 2 (default) -> Write Variables WV_LastRunTime -> End 2."
6. groovyScript "Script_PayloadLogging", fileName Script_PayloadLogging.groovy.
Code: if property PayloadLogging equals "TRUE" (ignore case), add the body to the message log as a text/plain
attachment named by property AttachmentName (default "Payload").
7. jsonToXml "JSON_to_XML_Records": add XML root element "root", use namespace mapping, JSON prefix separator ":".
8. PH "PH_Splitter_Records": "REPLACE WITH General Splitter 'Splitter Records': XPath /root/records, streaming off,
parallel off, stop on exception on, timeout 300."
9. groovyScript "Script_Mandatory_Fields", fileName Script_Mandatory_Fields.groovy.
Code: body is XML <root><records>...</records></root>; use the first record.
- Invalid XML: ValidationStatus = INVALID, ValidationError = "Invalid XML payload received", RecordId = UNKNOWN.
- No record: INVALID, "No record found in payload", RecordId = UNKNOWN.
- RecordId = id, or UNKNOWN if empty. region = region_north if not empty, else region_south.
- Mandatory (trimmed, not empty): id, status, title, region, category, assigned_group, description, created_on.
- Missing: INVALID, ValidationError = "Validation failed for record <RecordId>. Missing mandatory field(s): <names joined by ', '>".
- Otherwise: ValidationStatus = VALID, ValidationError = "". Always set RecordId.
10. contentModifier "CM_CustomHeaders". Properties: _MessageKeyElement4 constant RecordId;
_MessageKeyValue4 expression ${property.RecordId}.
11. groovyScript "Script_SetCustomHeaders", fileName Script_SetCustomHeaders.groovy.
Code: for each suffix "", "2", "3", "4": if properties _MessageKeyElement<suffix> and _MessageKeyValue<suffix>
are both set, add a message log custom header property (name = element value, value = value text cut to 250 chars).
12. PH "PH_Router_Validation": "REPLACE WITH Router 'Router Validation': Route 1 Non-XML ${property.ValidationStatus} = 'VALID' continues;
Route 2 (default) -> Process Call PC_ErrorHandling -> WV_LastRunTime -> Escalation End 3."
13. contentModifier "CM_SetTargetProperties". Properties (constant): SourceSystem = Source System;
AttachmentName = Target_ERP_Response; DocumentType = SR1; Priority = 2.
Description: "Manual: add XPath RecordStatus = //status, RecordId = //id".
14. PH "PH_Mapping_Source_to_ERP": "REPLACE WITH Message Mapping 'MM_Source_to_ERP': source SourceRecord.xsd (root),
target CreateDocument.wsdl (operation CreateDocument), value mappings Source/Region -> ERP/Plant (1000 if region empty)
and Source/Category -> ERP/PlannerGroup."
15. groovyScript "Script_Validate_ERP_Mapping", fileName Script_Validate_ERP_Mapping.groovy.
Code: start with ERPMappingStatus = VALID, ERPMappingError = "".
- Empty body: INVALID, "ERP request payload is empty."
- XML parse error (XmlSlurper, not namespace aware): INVALID, "Invalid ERP request XML."
- Find Plant and PlannerGroup anywhere (trimmed). Missing plant: error "No ERP plant found for the source region."
Missing group: error "No ERP planner group found for the source category."
- Any errors: INVALID, ERPMappingError = errors joined by a space.
16. PH "PH_Router_MappingCheck_RR_TargetERP": "REPLACE WITH (a) Router 'Router Mapping Check': Route 1 Non-XML ${property.ERPMappingStatus} = 'VALID'
continues; Route 2 (default) -> PC_ErrorHandling -> WV_LastRunTime -> Escalation End 4.
(b) Request Reply 'RR_Target_ERP' to RCV_TARGET_ERP, SOAP 1.x: address https://erp.example.com/soap/CreateDocument,
proxy On-Premise, location ID ERP_ONPREM, Basic auth credential ERP_BASIC_USER, timeout 60000."
17. groovyScript "Script_Get_ERP_Response", fileName Script_Get_ERP_Response.groovy.
Description: "Replaces CM_Set_Document_Number (XPath DocumentNumber)".
Code: parse body XML (namespace aware); ERPErrorCode = text of first element with local name ErrorCode,
ERPDocumentNumber = text of first element with local name DocumentNumber; both "" if missing or on parse error.
18. PH "PH_Router_ERPResult_PayloadLogging": "REPLACE WITH (a) Router 'Router ERP Result': Route 1 XML //*[local-name()='ErrorCode'] = '00'
continues to (b); Route 2 (default) -> CM_SetProperties_Failed (AttachmentName = Target_ERP_Failed_Response) ->
Script_PayloadLogging -> WV_LastRunTime -> End 5. (b) Script_PayloadLogging."
19. requestReplyHttp "RR_Get_Record_Key", system RCV_SOURCE_LOOKUP, GET, url {{Source_Lookup_URL}},
default: https://source.example.com/api/records?id=${property.RecordId}&fields=record_key,id
Description: "Manual: OAuth2 Client Credentials, credential SOURCE_OAUTH_CLIENT".
20. groovyScript "Script_Get_Record_Key", fileName Script_Get_Record_Key.groovy.
Description: "Replaces CM_Log_Record_Key (XPath //record_key)".
Code: if body starts with "{", parse JSON and take record_key of the first item in "records" (or of "records" if it is
an object); if it starts with "<", take the first element named record_key. Property RecordKey = that value or "".
21. PH "PH_Router_RecordFound": "REPLACE WITH Router 'Router Record Found': Route 1 XML //record_key != '' continues;
Route 2 (default) -> WV_LastRunTime -> End 6."
22. groovyScript "Script_Set_Update_Body", fileName Script_Set_Update_Body.groovy.
Code: read properties RecordId, RecordKey, ERPDocumentNumber; if one is empty, throw
new Exception("<property name> property is missing."). Set the body to JSON:
{"notes": "Target ERP document created for <RecordId>. Document number: <ERPDocumentNumber>",
"erp_document_number": "<ERPDocumentNumber>"} using groovy.json.JsonOutput.
23. contentModifier "CM_SetHeaders". Headers (constant): Accept = application/json; Content-Type = application/json.
24. requestReplyHttp "RR_Update_Record", system RCV_SOURCE_UPDATE, PATCH, url {{Source_Update_URL}},
default: https://source.example.com/api/records/${property.RecordKey}
Description: "Manual: OAuth2 Client Credentials, credential SOURCE_OAUTH_CLIENT".
25. PH "PH_WV_LastRunTime": "REPLACE WITH Write Variables 'WV_LastRunTime': lastRunTime =
${date-with-timezone:now:UTC:yyyy-MM-dd'T'HH:mm:ss.SSS'Z'}, local, encrypted, 90 days -> End."

Exception subprocess "Exception Subprocess":
description: "Manual: move these steps into Local Integration Process 'LIP_ErrorHandling';
here use Process Call 'PC_ErrorHandling' then Escalation End."
E1. contentModifier "CM_SetMessage". Properties: _MessageKeyValue3 expression ${property.ERPMappingError};
_MessageKeyElement3 constant ERPMappingError; _MessageKeyElement2 constant ValidationError;
_MessageKeyValue2 expression ${property.ValidationError}; _MessageKeyValue expression ${exception.message};
_MessageKeyElement constant Error_Message.
E2. groovyScript "Script_SetCustomHeaders_Exc", fileName Script_SetCustomHeaders_Exc.groovy.
Code: same logic as step 11.
```

What to expect:

- 25 main-flow steps: 17 real steps and 8 placeholders, plus a 2-step exception subprocess.
- Every receiver is created with authentication None; the step descriptions name the credentials to
  set in the CPI web editor.
- Importing the original iFlow (**Import iFlow**) gives a similar draft, with one placeholder per
  unsupported component instead of combined ones.
