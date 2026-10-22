# Pattern: one iFlow calls another (ProcessDirect)

v1 has no ProcessDirect sender or receiver. When the user asks for ProcessDirect, or for one iFlow
that calls another on the same tenant:
- Say plainly that v1 cannot build ProcessDirect, and offer this **workaround** (never call it an
  equivalent): the called iFlow gets an HTTPS sender with the address (e.g. `/pilot/notify`), and the
  caller calls that endpoint with `requestReplyHttp` (or the `httpReceiver` end). The difference
  matters: ProcessDirect stays inside the tenant and needs no authentication; an HTTPS endpoint is
  public and every call to it must be authenticated.
- **Authentication is required**, not optional. Create the caller's receiver with `authType: "None"`
  as always, and tell the user they must set **OAuth2 Client Credentials** on it before deploying,
  with a credential from a service key of a **Process Integration Runtime** instance with plan
  **integration-flow** (it grants the role `ESBMessaging.send` that the HTTPS sender built by v1
  requires). Never write "if the target requires it".
- **URL:** the endpoint is on the tenant's **runtime host** (the host name contains `-rt`), path
  `/http/<address>`, e.g. `https://<tenant>.it-cpi<nn>-rt.cfapps.<region>.hana.ondemand.com/http/pilot/notify`.
  The exact URL of a deployed iFlow is in *Monitor → Integrations and APIs → Manage Integration
  Content*. Externalize it as a parameter named after the target iFlow, e.g. `{{CommonNotifyURL}}`,
  never `ProcessDirectURL`.
- **CSRF:** iFlows built by v1 create the HTTPS sender with *CSRF Protected* off, so the caller needs
  no CSRF token. Tell the user this, and that if the target's HTTPS sender has *CSRF Protected* on
  (the default for senders created in the CPI web editor), a caller without a token gets HTTP 403.
