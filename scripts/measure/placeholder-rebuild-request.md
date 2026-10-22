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
