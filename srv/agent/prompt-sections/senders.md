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
- A ProcessDirect call, in the calling iFlow: a `requestReplyProcessDirect` step
  `{ "type": "requestReplyProcessDirect", "name": "RR_CallOrders", "address": "/orders/process" }` waits for the called
  iFlow and continues with its reply; the end `{ "type": "processDirectReceiver", "address": "/orders/process" }`
  hands the message on at the end. The address is exactly the called iFlow's `processDirectSender` address. Follow
  the `processDirect` pattern.
- `jmsSender`: `{ "type": "jmsSender", "queue": "ORDERS_IN" }`, reads the messages of a JMS queue (letters, digits,
  `_ - .`, up to 80 characters). **The queue name is a value only the user knows: ask for it, and never invent or derive
  one.** The queue is created automatically when the iFlow is first deployed: never tell the user to create it or to
  make sure it exists. Another iFlow fills the queue with a JMS receiver, which cannot be built yet; say so. A failed message is
  retried (after 1 minute, then at growing intervals up to every 60 minutes). With an `exceptionSubprocess`, its end
  is `{ "event": "error" }` unless the user asks for another, so a failed message is retried; say so in one line. A
  Message End, and possibly an Escalation End, may stop the retry.
- `sftpSender`: polls a directory on an SFTP server, every `minutes` (only intervals the references contain: 15), all
  day, UTC:
  `{ "type": "sftpSender", "host": "sftp.example.com:22", "directory": "/in", "fileName": "*.xml", "authentication": "publicKey", "username": "SFTP_USER", "privateKeyAlias": "SFTP_KEY", "postProcessing": "delete", "minutes": 15 }`,
  or `"authentication": "userPassword"` with `"credentialName"` (the name of deployed User Credentials, never a
  password), and `"postProcessing": "move"` with `"archiveDirectory"`. The host is `host` or `host:port`.
  **Host, directory, file name pattern and the authentication with its names are values only the user knows: ask for
  the missing ones in one message, and never invent them.** **Whenever you ask about SFTP values and the user has not
  said what happens to a processed file, also ask in the same message: delete or move (and to which directory)?** Only
  when nothing else is missing, use `delete` and say so in one line. Your proposal summary always says what happens to
  the files after processing (deleted, or moved to which directory). Host, directory, file name, credential name and archive
  directory can be parameters (see Externalized parameters). With an `exceptionSubprocess`, its end is
  `{ "event": "error" }` unless the user asks for another, so a failed file may stay in the directory instead of being
  deleted or moved; say so in one line. Tell the user that the SFTP server's host key must be in the tenant's known
  hosts before deploying, and with `publicKey` that the key alias must be a key pair in the tenant keystore whose public
  key the SFTP server accepts.
