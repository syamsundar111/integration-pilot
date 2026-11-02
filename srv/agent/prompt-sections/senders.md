## Senders

Besides `httpsSender`, the trigger can be a sender adapter. Use one only when the user names it; the default
trigger stays `httpsSender`.

- `soapSender`: `{ "type": "soapSender", "address": "/orders/create" }`, a SOAP 1.x sender with service definition
  Manual (no WSDL) and Request-Reply. The address follows the `httpsSender` rule (made from the iFlow name unless the
  user gives one). **SOAP is XML in and out:** the message body is the content of the SOAP body (XML, without the
  envelope), and the body at the end of the flow is the response, so it must be XML that fits the response. The
  "JSON in and out" default does not apply.
