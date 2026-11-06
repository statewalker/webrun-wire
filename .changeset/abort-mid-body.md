---
"@statewalker/webrun-http-streams": patch
"@statewalker/webrun-http-browser": patch
---

An abort of a request's signal ends its response body at once, whether a read is waiting or not. `fetchOverDuplex` used to look at the signal only when the next chunk arrived, so a read waiting on a peer that sent nothing more hung, and an unread body kept its call (on a multiplexed link, its port) until someone read it. Now the abort errors the body with the abort's reason, rejects a waiting read, and abandons the call. A link's `inflight` count and `whenIdle()` drop the request at the abort too. The listener on the signal is removed once the body ends, however it ends. A cancelled body abandons its call at once too: with a read waiting on a quiet peer, the cancel used to wait behind that read, and the call (and its port) stayed open for good.
