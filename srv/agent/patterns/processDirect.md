# Pattern: one iFlow calls another (ProcessDirect)

When the user asks for ProcessDirect, or for one iFlow that calls another on the same tenant:
- **The called iFlow** gets `{ "type": "processDirectSender", "address": "/..." }` (see Senders). Headers and the
  body reach it; exchange properties of the caller may not, so the caller passes values as headers.
- **The caller** calls it at exactly the called iFlow's address: with a `requestReplyProcessDirect` step
  (`{ "type": "requestReplyProcessDirect", "name": "RR_CallOrders", "address": "/orders/process" }`) when it needs the
  reply, which then continues in the caller as the message body; with the end
  `{ "type": "processDirectReceiver", "address": "/orders/process" }` when it only hands the message on at the end.
- **The address** is the called iFlow's `processDirectSender` address, exactly. When both iFlows are built in this
  conversation, use the same address in both; for an iFlow that already exists, ask the user for its address and never
  invent one. It can be a whole parameter (`{{Orders_Address}}` with the address as its default).
- **Deploy order:** the called iFlow must be deployed on the same tenant before the caller runs; tell the user,
  especially when the caller has a timer. No authentication: ProcessDirect stays inside the tenant.
- Only when the user asks for the call over HTTPS instead, offer this **workaround** (never call it an
  equivalent): the called iFlow gets an HTTPS sender with the address (e.g. `/pilot/notify`), and the caller calls that endpoint with `requestReplyHttp` (or the `httpReceiver` end). The difference
  matters: ProcessDirect stays inside the tenant and needs no authentication; an HTTPS endpoint is
  public and every call to it must be authenticated.
- **Authentication is required**, not optional. Create the caller's receiver with
  `authType: "OAuth2 Client Credentials"` and the `credentialName` the user gives (ask for it if they
  name none), and tell them it must be deployed from a service key of a **Process Integration
  Runtime** instance with plan **integration-flow** (it grants the role `ESBMessaging.send` that the
  HTTPS sender built by the app requires). Never write "if the target requires it".
- **URL:** the endpoint is on the tenant's **runtime host** (the host name contains `-rt`), path
  `/http/<address>`, e.g. `https://<tenant>.it-cpi<nn>-rt.cfapps.<region>.hana.ondemand.com/http/pilot/notify`.
  The exact URL of a deployed iFlow is in *Monitor → Integrations and APIs → Manage Integration
  Content*. Externalize it as a parameter named after the target iFlow, e.g. `{{CommonNotifyURL}}`,
  never `ProcessDirectURL`.
- **CSRF:** iFlows built by the app create the HTTPS sender with *CSRF Protected* off, so the caller needs
  no CSRF token. Tell the user this, and that if the target's HTTPS sender has *CSRF Protected* on
  (the default for senders created in the CPI web editor), a caller without a token gets HTTP 403.
