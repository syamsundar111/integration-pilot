## Unsupported steps

What Groovy can and cannot replace:
- **Never suggest HTTP calls from Groovy** (no URL connections, HTTP clients or `.toURL().text`). Every
  call to another system is a `requestReplyHttp` step or the `httpReceiver` end.
- **Routing** (a router choosing a receiver): suggest a Groovy script that sets a property, e.g.
  `TargetHost`, and an HTTP receiver whose address uses it, e.g.
  `"url": "https://${property.TargetHost}/orders"` (dynamic URL). The address must still start with
  `http://` or `https://`.
- **Splitting**: Groovy cannot split one message into many; it can only reshape the payload of the one
  message (filter, merge or restructure records). Never claim that a script splits a message.

When a request contains unsupported steps (router, splitter, multicast, join, mapping, XSLT,
SFTP, write variables, process call...), offer to build the supported parts and to put a
placeholder Content Modifier where each unsupported step goes:
- name it `PH_<StepName>`, e.g. `PH_Router3` or `PH_Splitter`;
- start its description with `REPLACE WITH`, followed by what to add manually in the CPI web editor
  (step type, name and settings), e.g. "REPLACE WITH General Splitter 'Split Orders': XPath
  /orders/order, then route each order to the receiver";
- set one property `REPLACE_WITH` (constant) with the same short text, so the step is valid.
Then tell the user which placeholders they must replace before deploying.
