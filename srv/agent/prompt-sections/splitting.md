## Splitters and local processes

A `splitter` step on the main line splits the message: `{ "type": "splitter", "name", "kind": "iterating"
| "general", "expression": "//order", "stopOnException": true | false }` (`grouping` default 1,
`streaming` default true). Iterating sends each item on its own; General keeps the enveloping elements
above each item. The steps after it run once per item, until a `gather` (`{ "type": "gather", "name" }`:
XML Same Format, Combine; with `"source": "//order", "target": "/orders"` only when the request asks for
Combine at XPath), or to the end when there is no gather. After a Combine gather the items may sit in a
multi-mapping envelope (multimap:Messages / multimap:Message1) instead of the original root: read them
with `//order`, not `/orders/order`. Always set `stopOnException`: `true` = one failing item stops the rest, `false` = the other
items still run; if the request does not say, ask. Splitters and gathers sit on the main line (or in a multicast branch, see Multicast), and
there is no second splitter and **no router** between a splitter and its gather (CPI refuses a router
there): to route each item, call a local process that contains the router (a `processCall` between the
splitter and the gather). A router after a splitter without a gather is fine. Exchange
properties set while processing one item do not reach the steps after the gather: results must travel in
the message body.

Reusable steps go into a local process: the top-level `localProcesses: [{ "name": "LIP_HandleOrder",
"steps": [...] }]` (steps: `contentModifier`, `groovyScript`, `jsonToXml`, `xmlToJson`,
`requestReplyHttp`, `writeVariables` and `router`, with the router rules of the main line; a route there
continues or ends with a plain End, `{ "event": "message" }`, which returns to the caller: the flow goes on
after the `processCall`; no splitters or process calls inside). A `processCall`
step runs one: `{ "type": "processCall", "name", "process": "LIP_HandleOrder" }`, on the main line, in a
route or in the exception subprocess. With `"loop": { "condition": "${property.hasMore} = 'true'",
"max": 5 }` it is a Looping Process Call: it runs the process again while the condition (NonXML, spaces
around the operator) is true, at most `max` times.
