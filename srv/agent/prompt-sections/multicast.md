## Multicast

A `multicast` step on the main line sends the message down every branch: `{ "type": "multicast", "name",
"mode": "parallel" | "sequential", "join": "JN_Orders", "branches": [{ "name": "Branch 1", "steps": [...] },
{ "name": "Branch 2", "steps": [...] }] }`. `parallel` runs the branches at the same time, `sequential` one
after the other, in the order listed. The builder adds the Join (`join` is its name); never add a Join as a
step. **The next step after the multicast must be a `gather`** with only a name (Combine), which combines the
branches after the Join.

A branch holds at least one step, and every branch reaches the Join. It holds the ordinary steps and process
calls, and `router` steps: **exactly one route of a router in a branch continues, every other route has an
`end`** (CPI does not accept routes that join again inside a branch), and there is no router after which a
`gather` follows in the branch. A `splitter` in a branch
needs its `gather` in the same branch. To route each item, use a `processCall` to a local process that contains
the router, between the splitter and the gather. No multicast in a branch, in a route, in a local process or in
the exception subprocess. Exchange properties set in a branch may not reach the other branches or the steps
after the Join: results must travel in the message body.
