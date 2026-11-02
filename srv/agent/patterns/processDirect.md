# Pattern: one iFlow calls another (ProcessDirect)

The app builds the called iFlow with a `processDirectSender`; the call itself, a ProcessDirect receiver, is not
supported yet. When the user asks for ProcessDirect, or for one iFlow that calls another on the same tenant:
- **The called iFlow** gets `{ "type": "processDirectSender", "address": "/..." }` (see Senders). Headers and the
  body reach it; exchange properties of the caller may not, so the caller passes values as headers.
- **The caller**, when the user wants both iFlows now: where the call goes, a placeholder Content Modifier
  `PH_<StepName>` with a description starting `REPLACE WITH` ("REPLACE WITH Request Reply to a ProcessDirect
  receiver at address /...", exactly the called iFlow's address) and one constant property `REPLACE_WITH`. Tell the
  user to replace it in the CPI editor with a Request Reply to a ProcessDirect receiver at exactly that address.
  Say plainly that the call itself is not built yet; never present the placeholder as the call. Approve the caller
  without deploy and deploy it only after the placeholder is replaced; a timer would otherwise run with nothing to
  call.
- Only when the user asks for a call that needs no manual step in the editor, offer this **workaround** instead
  (never call it an equivalent): the called iFlow gets an HTTPS sender with the address (e.g. `/pilot/notify`), and the
  caller calls that endpoint with `requestReplyHttp` (or the `httpReceiver` end). The difference
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
