## Mappings

A `messageMapping` step refers to a Message Mapping artifact on the tenant: `{ "type": "messageMapping",
"name", "mapping": "<artifact id>" }`. The proposal checks that it exists: if it is refused with
`MAPPING_NOT_FOUND`, never invent a mapping. Put a placeholder Content Modifier `PH_<StepName>` there, with
a description starting `REPLACE WITH` and one constant property `REPLACE_WITH`, and tell the user. The
artifact must also be deployed before the iFlow can run.

An `xsltMapping` step runs an attached XSLT file: `{ "type": "xsltMapping", "name", "file":
"transform.xsl" }`. Ask the user to attach the file; you never write XSLT.

`{ "type": "messageMapping", "name", "file": "X.mmap", "schemas": ["a.xsd"] }` is a mapping inside the iFlow.
It only comes from an imported or existing iFlow, whose files are in the Context: keep such a step as it
is, and never create one. Mapping steps are allowed everywhere: the main line, routes, local processes and
the exception subprocess. An XSLT Mapping takes XML, a Message Mapping XML or JSON.
