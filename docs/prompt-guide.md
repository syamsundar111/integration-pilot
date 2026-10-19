# Writing requests for Integration Pilot

Integration Pilot turns a chat request into an iFlow proposal. A request that gives the
assistant everything up front gets a proposal in one turn. A request that leaves things
open costs extra rounds of questions, and every round re-sends the whole conversation to the
model. This guide shows how to write requests that work the first time, and walks through one
real request: **SF SourceApp EC to Target Directory**.

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
1. <step type and name, e.g. Content Modifier "Set Properties": property Source = constant SF>
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
  *OAuth2 SAML Bearer with credential DEMO_OAUTH on all receivers*.

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
  *REPLACE WITH …*.
- If the flow would exceed 50 steps, consecutive placeholders are merged.
- Duplicate names are made unique.
- XPath values of Content Modifiers move into a generated Groovy script.
- Scripts and XSLT files become attachments.

Then ask *Propose the imported iFlow as a new iFlow* and replace the placeholders in the CPI web
editor after creation.

## Worked example: SF SourceApp EC to Target Directory

### The original request

The original request was precise about the flow: a timer, a Content Modifier with 16 constants,
two SourceApp calls with externalized URLs, two Content Modifiers that keep the responses,
a Groovy mapping, and an exception subprocess. It is in
[scripts/measure/sf-entra-request.md](../scripts/measure/sf-entra-request.md). Three things made
it expensive:

1. **No package and no authentication.** The assistant asked about both, which took one extra
   round. The answers came in a second message.
2. **About 60 lines of Groovy described in prose** (steps 7a–7h and the error script). The model
   had to write both scripts inside the spec, in one response of 5,000–10,000 tokens. On the
   free-tier model that took 1–4 minutes per attempt, and attempts timed out at 120 s.
3. **Every revision re-sent the full spec**, scripts included, and the conversation history grew
   with each copy.

### The improved request

1. Set the session defaults:
   - Target package `DEV.SF.SourceApp.EC.to.Microsoft.Directory.ID`
   - Timer, run once after deployment
   - Receiver authentication: *OAuth2 SAML Bearer Assertion with credential DEMO_OAUTH on
     RCVR_SF_User and RCVR_SF_AccountLockOut*
2. Attach the two scripts: `mapSfToEntra.groovy` (step 7 of the original request) and
   `buildErrorNotification.groovy` (step c of its exception subprocess). Versions of both are in
   [test/fixtures/sf-entra/](../test/fixtures/sf-entra/).
3. Send the request, which no longer describes the scripts:

<!-- example:improved-request -->
```text
Create an iFlow.
Name: SF SourceApp EC to Target Directory_Employee Data Replication_V1
ID: SF_SourceApp_EC_to_Microsoft_Directory_ID_Employee_Data_Replication_V1
Purpose: read employees from SourceApp Employee Central, map them to the Target Directory
layout and produce a CSV file.
Steps (in order):
1. Content Modifier "Set Properties", constant properties:
   sourceAgency_EmpType = SF, sourceIdentifier_EmpType = SF_EmpType,
   targetAgency_EmpType = Directory, targetIdentifier_EmpType = Directory_EmpType,
   sourceAgency_EmpSubGroup = SF_EmpSub, sourceIdentifier_EmpSubGroup = SF_EmpSubGroup,
   targetAgency_EmpSubGroup = Directory_EmpSub, targetIdentifier_EmpSubGroup = Directory_EmpSubGroup,
   toemailaddresses = alerts@example.com, ccemailaddresses = alerts@example.com,
   emailfrom = noreply@example.com,
   emailsubject = SF SourceApp EC to Target Directory_Employee Data Replication,
   environment = DEV-COMMON,
   iflowname = DEV_SF SourceApp EC to Target Directory_Employee Data Replication,
   packagename = DEV_SF SourceApp EC to Target Directory, FileName = EmployeeDataReplication.csv
2. Request-reply "Get SF Users": GET, receiver RCVR_SF_User, URL {{SF_User_URL}}, default
   https://api.example.com/odata/v2/User?$format=json&$filter=status in 't','f'&$select=userId,username,empId,firstName,mi,lastName,displayName,email,title,department,location,status,hireDate,companyExitDate,custom06,custom07,manager/empId,empInfo/jobInfoNav/locationNav/description,empInfo/jobInfoNav/locationNav/addressNavDEFLT/address1,empInfo/jobInfoNav/locationNav/addressNavDEFLT/city,empInfo/jobInfoNav/locationNav/addressNavDEFLT/zipCode,empInfo/jobInfoNav/departmentNav/description,empInfo/jobInfoNav/jobCodeNav/name,empInfo/jobInfoNav/jobCodeNav/description&$expand=manager,empInfo/jobInfoNav/locationNav/addressNavDEFLT,empInfo/jobInfoNav/departmentNav,empInfo/jobInfoNav/jobCodeNav
3. Content Modifier "Store SF Users": property SFUsersJson = expression ${in.body}
4. Request-reply "Get Account Lockout": GET, receiver RCVR_SF_AccountLockOut, URL {{SF_AccountLockout_URL}},
   default https://api.example.com/odata/v2/cust_AccountLockout?$format=json&$select=externalCode,cust_AccountLockout
5. Content Modifier "Store Account Lockout": property LockoutJson = expression ${in.body}
6. Groovy Script "Map SF to Directory and Build CSV" using the attached mapSfToEntra.groovy
No receiver at the end.
Error handling: exception subprocess "Exception Subprocess 1" with
- Content Modifier "Set Error Properties": ErrorMessage = expression ${exception.message},
  ErrorTimestamp = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}
- Groovy Script "Build Error Notification" using the attached buildErrorNotification.groovy
Give every step a one-sentence description of its purpose.
```

The prompt check passes with the defaults set. The request is half as long (2.8 instead of 5.6
thousand characters). The model has no questions to ask and writes a spec without script
bodies: 4.7 KB of JSON instead of 10 KB. It validates the spec with
`validateSpec` and proposes it with `{ "useValidatedSpec": true }`, so the spec is written once.
The expected spec is
[test/fixtures/sf-entra/spec.json](../test/fixtures/sf-entra/spec.json): 6 steps, 2
externalized URLs, an exception subprocess with 2 steps, and the two scripts as attached
files. `test/prompt-guide.test.js` checks this example: the linter result, the validation and
build of the spec with the attached scripts, and an import of the built iFlow back into the
same spec.

### After creation

The proposal panel lists what to finish in the CPI web editor. For this iFlow:

- Set **OAuth2 SAML Bearer Assertion** with credential **DEMO_OAUTH** on the receivers
  RCVR_SF_User and RCVR_SF_AccountLockOut.
- Configure the value mappings `SF_EmpType` → `Directory_EmpType` and `SF_EmpSubGroup` →
  `Directory_EmpSubGroup` on the tenant.
- Set the production schedule on the timer when the flow goes live.

## Worked example: SourceSystem to S/4HANA (25 steps)

A larger flow between two non-SAP-SourceApp systems: active hardware incidents from SourceSystem
become S/4HANA maintenance notifications, and the notification numbers are written back. The request
gives everything up front: package, trigger, the authentication to set up after creation, 25
numbered steps with names, every URL as a parameter with a default, and the error handling.
`RUNID` stands for a unique suffix (the measurement script replaces it); use your own ID and name.

<!-- example:SourceSystem-s4-request -->
```text
Create an iFlow.
Name: SourceSystem to S4HANA Maintenance Notifications RUNID
ID: SourceSystem_to_S4HANA_Notifications_RUNID
Package: PilotReference
Trigger: timer, run once after deployment.
Authentication: SourceSystem receivers use Basic with credential SNOW_API_USER; S/4HANA receivers use
OAuth2 Client Credentials with credential S4_OAUTH. Create them with None; I set them up in the CPI
web editor after creation.
Purpose: read active hardware incidents from SourceSystem, create S/4HANA maintenance notifications for
them, and write the notification numbers back to SourceSystem.

Steps (in order):
1. Content Modifier "Set Properties": constant properties sourceSystem = SourceSystem, targetSystem = S4HANA, plant = 1010, notificationType = M1, batchSize = 50
2. Request-Reply "Get Incidents": GET, receiver RCVR_SourceSystem, URL {{SNOW_Incidents_URL}}, default https://source.example.com/api/now/table/incident?sysparm_query=active%3Dtrue%5Ecategory%3Dhardware&sysparm_limit=50
3. Content Modifier "Store Incidents": property IncidentsJson = expression ${in.body}
4. Groovy Script "Filter Incidents": from IncidentsJson.result keep incidents with priority 1, 2 or 3 and a non-empty assignment_group; set property IncidentCount; set the body to the kept incidents as a JSON array.
5. Content Modifier "Store Filtered Incidents": property FilteredJson = expression ${in.body}
6. Request-Reply "Get Equipment": GET, receiver RCVR_S4_Equipment, URL {{S4_Equipment_URL}}, default https://s4.example.com/sap/opu/odata/sap/API_EQUIPMENT/Equipment?$format=json&$top=500
7. Content Modifier "Store Equipment": property EquipmentJson = expression ${in.body}
8. Request-Reply "Get Functional Locations": GET, receiver RCVR_S4_FuncLoc, URL {{S4_FuncLoc_URL}}, default https://s4.example.com/sap/opu/odata/sap/API_FUNCTIONALLOCATION/FunctionalLocation?$format=json&$top=500
9. Content Modifier "Store Functional Locations": property FuncLocJson = expression ${in.body}
10. Groovy Script "Map to Notifications": for each incident in FilteredJson build an S/4HANA maintenance notification: NotificationText = short_description cut to 40 characters, MaintNotifLongText = description, MaintPriority = the incident priority, TechnicalObject = the Equipment whose SerialNumber equals the incident's cmdb_ci serial number (empty if none), FunctionalLocation = the functional location whose description equals the incident location (empty if none), NotificationType and MaintenancePlant from the properties notificationType and plant, and keep the incident sys_id; body = {"notifications": [...]}.
11. Content Modifier "Store Notifications": property NotificationsJson = expression ${in.body}
12. Content Modifier "Set CSRF Fetch Header": header x-csrf-token = constant Fetch
13. Request-Reply "Fetch CSRF Token": GET, receiver RCVR_S4_Token, URL {{S4_Notification_Service_URL}}, default https://s4.example.com/sap/opu/odata/sap/API_MAINTNOTIFICATION
14. Content Modifier "Keep CSRF Token": property CsrfToken = expression ${header.x-csrf-token}
15. Groovy Script "Prepare Batch": set the body to property NotificationsJson, header x-csrf-token to property CsrfToken and header Content-Type to application/json.
16. Request-Reply "Create Notifications": POST, receiver RCVR_S4_Notification, URL {{S4_Notification_Batch_URL}}, default https://s4.example.com/sap/opu/odata/sap/API_MAINTNOTIFICATION/MaintenanceNotification
17. Content Modifier "Store S4 Response": property S4Response = expression ${in.body}
18. Groovy Script "Read Notification Numbers": parse S4Response; build a list of {sys_id, notification} pairs from the created notifications; set property CreatedCount; body = the list as JSON.
19. Content Modifier "Store Mapping": property MappingJson = expression ${in.body}
20. Groovy Script "Build SourceSystem Updates": for each pair build {"sys_id": ..., "u_s4_notification": ..., "work_notes": "Created S/4HANA notification <number>"}; body = {"records": [...]}.
21. Request-Reply "Update Incidents": POST, receiver RCVR_SourceSystem_Update, URL {{SNOW_Batch_Update_URL}}, default https://source.example.com/api/x_pilot/incident_batch_update
22. Content Modifier "Store Update Response": property UpdateResponse = expression ${in.body}
23. Groovy Script "Build Run Summary": set property Summary = "incidents read <n>, kept <IncidentCount>, notifications created <CreatedCount>".
24. Content Modifier "Set Run Status": property RunStatus = constant Success, header SAP_ApplicationID = expression ${property.Summary}
25. Groovy Script "Final Check": throw an exception if CreatedCount differs from IncidentCount.
No receiver at the end.
Error handling: exception subprocess with
- Content Modifier "Set Error Properties": property ErrorMessage = expression ${exception.message}, property ErrorTime = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}
- Groovy Script "Build Error Mail Body": body = plain text with ErrorTime, ErrorMessage and Summary (if set).
```

What to expect:

- The assistant writes the 7 Groovy scripts with `writeScript` and builds the spec in parts.
- Receivers are created with authentication None; the proposal panel reminds you to set Basic
  (`SNOW_API_USER`) and OAuth2 Client Credentials (`S4_OAUTH`) on them in the CPI web editor.
- The URL defaults are placeholders: set the real SourceSystem and S/4HANA addresses as externalized
  parameters before deploying.

