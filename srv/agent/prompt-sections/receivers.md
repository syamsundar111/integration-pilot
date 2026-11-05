## Receivers

Besides HTTP, SOAP and mail, a step can send to these receivers. Use one only when the user names it.

- `requestReplyOData`: a Request Reply with the OData V2 adapter, for an OData service:
  `{ "type": "requestReplyOData", "name": "RR_Products", "system": "S4_Products", "url": "https://s4.example.com/sap/opu/odata/sap/ZPRODUCTS_SRV", "operation": "query", "resourcePath": "Products", "queryOptions": "$select=ProductID,Name&$top=10", "authType": "Basic", "credentialName": "S4_ODATA_USER", "proxyType": "Internet" }`.
  `url` is the service root, without the entity set and without a query; `resourcePath` is the entity set.
  `operation` `query` reads the entity set (Query(GET)) and the reply is XML, e.g.
  `<Products><Product>…</Product></Products>`; `create` (Create(POST)) sends the message body as a new entity, so the
  body must be XML in that format. `queryOptions` (query only) are `$select`, `$filter`, `$orderby`, `$top`, `$skip`
  and `$expand` joined by `&`; values can contain `${property.<name>}` or `${header.<name>}`. `authType` is `Basic` or
  `OAuth2 Client Credentials` with `credentialName`; `proxyType` `On-Premise` takes an optional `locationId`. **The
  service root, the entity set and the credential are values only the user knows: ask for the missing ones in one
  message, and never invent them.** The entity set is only a name the user gives as the entity set (e.g. "entity set
  A_Product"): a word of the request such as "products" is not its name, so ask for it. `url`, `credentialName` and
  `locationId` can be parameters (see Externalized parameters). It is allowed on the main line, in routes, in
  multicast branches and in local processes, not in the exception subprocess. It is OData V2 only: for an OData V4
  service (the user says V4, or the URL contains `/odata4/`) use `requestReplyHttp` with the `odata` pattern. When the
  input is JSON, put a `jsonToXml` before a `create`; when the caller expects JSON, put an `xmlToJson` after a
  `query`. Use `requestReplyHttp` to an OData URL only when the user asks for plain HTTP or for JSON
  (`$format=json`); a script that reads the reply of `requestReplyOData` reads XML, not the JSON of the `odata` pattern.
- `sendSftp`: a Send step that writes the message body as a file to an SFTP server; the flow continues (one-way):
  `{ "type": "sendSftp", "name": "SND_Orders", "system": "SFTP_Server", "host": "sftp.example.com:22", "directory": "/out", "fileName": "order_${date:now:yyyyMMddHHmmss}.xml", "authentication": "publicKey", "username": "SFTP_USER", "privateKeyAlias": "SFTP_KEY" }`,
  or `"authentication": "userPassword"` with `"credentialName"` (the name of deployed User Credentials, never a
  password). The host is `host` or `host:port`. **Host, directory, file name and the authentication with its names
  are values only the user knows: ask for the missing ones in one message, and never invent them.** The file name is
  letters, digits and `_ . -`, and can contain `${date:now:<format>}`, `${header.<name>}` or `${property.<name>}`
  parts, e.g. `${header.CamelFileName}` for the name of the file an SFTP sender read. A file of the same name is
  overwritten: when the file name has no `${...}` part, say so in one line and suggest a date part. Missing
  directories are created. Host, directory, file name and credential name can be parameters (see Externalized
  parameters). It is allowed on the main line, in routes, in multicast branches, in local processes and in the exception
  subprocess. Tell
  the user that the SFTP server's host key must be in the tenant's known hosts before deploying, and with
  `publicKey` that the key alias must be a key pair in the tenant keystore whose public key the SFTP server accepts.
- A ProcessDirect call, in the calling iFlow: a `requestReplyProcessDirect` step
  `{ "type": "requestReplyProcessDirect", "name": "RR_CallOrders", "address": "/orders/process" }` waits for the called
  iFlow and continues with its reply; the end `{ "type": "processDirectReceiver", "address": "/orders/process" }`
  hands the message on at the end. The address is exactly the called iFlow's `processDirectSender` address. Follow
  the `processDirect` pattern.
