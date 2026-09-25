---
"@statewalker/webrun-http-proxy": patch
---

Fix: `urlUpstream` sent no body at all in Firefox. Firefox (checked against
155) has no `Request.prototype.body` — the property reads `undefined` there
even for a genuine payload — so rebuilding the outbound request with `body:
request.body` silently dropped every POST/PUT/PATCH body in that engine while
working in Chromium, where the property is a stream. A POST through a session
origin arrived as `0 bytes of 76 sent`, Firefox only, nothing else in the
response indicating loss.

This is the fifth site of the same defect; four were already fixed in
`statewalker/httpeers` (`edge-dispatch.ts`, two in `core/router.ts`, a demo
page).

The fix buffers via `arrayBuffer()` only when `request.body` reads absent — a
real stream still streams, so a large upload through a runtime that supports
request streams is never held in memory. `duplex: "half"` is now set only when
the outbound body is actually a `ReadableStream`.
