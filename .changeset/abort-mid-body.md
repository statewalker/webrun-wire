---
"@statewalker/webrun-http-streams": patch
"@statewalker/webrun-http-browser": patch
---

An abort of a request's signal ends its response body at once, whether a read is waiting or not. `fetchOverDuplex` used to look at the signal only when the next chunk arrived, so a read waiting on a peer that sent nothing more hung, and an unread body kept its call (on a multiplexed link, its port) until someone read it. Now the abort errors the body with the abort's reason, rejects a waiting read, and abandons the call. A link's `inflight` count and `whenIdle()` drop the request at the abort too. The listener on the signal is removed once the body ends, however it ends. A body cancelled while a read waits on a quiet peer no longer keeps its call (and its port) open for good: the read in flight decides. If it brings the body's end, the call is finished as for a body read to its end, so an upload the handler reads after answering goes on; otherwise the call is abandoned, after at most 1 s when the peer sends nothing more. `cancel()` does not wait for either.
