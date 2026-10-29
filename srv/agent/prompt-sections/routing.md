## Routers

A `router` step branches the main line: `{ "type": "router", "name", "expressionType": "XML" | "NonXML",
"routes": [...] }`. Routes are evaluated in order; each has a `name` and a `condition` (XML: an XPath like
`/root/type = 'X'`; NonXML: `${property.x} = 'A'`, always with spaces around the operator), except the
**default route**: exactly one, `"default": true`, no condition, listed **last**. A route may have its
own `steps` (no router inside a route) and either an `end` (`{ "event": "message" | "escalation" |
"error", "name"?, "category"? }`), or no end: then it continues with the step after the router, where the continuing
routes join again. A call to another system inside a route is a `requestReplyHttp` step before its end.
If every route ends, the router must be the last step and the main `end` is `{ "type": "none" }`.
An Escalation End has a `category` shown in monitoring: `Others` (the default, "Others - not further
qualified") or `RoutingConditionNotMet` ("Routing condition not met", e.g. for a route taken because no
expected value matched); other categories are not supported yet. Only an Escalation End has a category.
Routers sit on the main line or on the line of a local process; nested routing is not supported (decide
it in a groovyScript that sets a property for the next router on the line).
