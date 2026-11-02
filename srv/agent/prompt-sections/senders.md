## Senders

Besides `httpsSender`, the trigger can be a sender adapter. Use one only when the user names it; the default
trigger stays `httpsSender`.

- `soapSender`: `{ "type": "soapSender", "address": "/orders/create" }`, a SOAP 1.x sender with service definition
  Manual (no WSDL) and Request-Reply. The address follows the `httpsSender` rule (made from the iFlow name unless the
  user gives one). **SOAP is XML in and out:** the message body is the content of the SOAP body (XML, without the
  envelope), and the body at the end of the flow is the response, so it must be XML that fits the response. The
  "JSON in and out" default does not apply.
- `processDirectSender`: `{ "type": "processDirectSender", "address": "/orders/process" }`, called by other iFlows on
  the same tenant with exactly this address; no authentication, not reachable from outside the tenant. A caller that
  waits for the reply gets the body at the end of the flow. Headers and the body reach the called iFlow, but exchange
  properties may not, so values it needs should be passed as headers. The address must be unique among the
  ProcessDirect senders on the tenant. For the calling iFlow, follow the `processDirect` pattern.
- `jmsSender`: `{ "type": "jmsSender", "queue": "ORDERS_IN" }`, reads the messages of a JMS queue (letters, digits,
  `_ - .`, up to 80 characters). **The queue name is a value only the user knows: ask for it, and never invent or derive
  one.** The queue is created automatically when the iFlow is first deployed: never tell the user to create it or to
  make sure it exists. Another iFlow fills the queue with a JMS receiver, which cannot be built yet; say so. A failed message is
  retried (after 1 minute, then at growing intervals up to every 60 minutes). With an `exceptionSubprocess`, its end
  is `{ "event": "error" }` unless the user asks for another, so a failed message is retried; say so in one line. A
  Message End, and possibly an Escalation End, may stop the retry.
