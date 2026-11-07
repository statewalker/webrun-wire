---
"@statewalker/webrun-http-browser": patch
---

`ServerWebSocket`, through `upgradeWebSocket`'s options, carries what other platforms' server ends need. workerd's `WebSocketPair` can be built on it:

- `heartbeatPeriod: "first"` keeps the first ping's period. A page announces a longer one when it turns hidden, and a closing tab turns hidden on its way out.
- `sendBeforeAccept` lets `send()` before `accept()`.
- `deliverWhileClosing` delivers the messages that were in flight when `close()` was called.
- `defaultCloseCode` is the code `close()` sends when given none, for example 1005.
- `closeTimeoutMs: Infinity` waits for the close echo for as long as it takes. A timer given Infinity used to fire at once.
- `binaryType` can be `"blob"`.
- A subclass can override `checkClose(code, reason)` with its platform's close rules.
- `detach()` hands an unaccepted end's port to another holder, with the frames that reached it delivered first. Acks the end was still owed are absorbed on the way.

A ping announcing a period no timer takes (2³¹−1 ms or more, a client that turned its heartbeat off) stops the heartbeat watch rather than arming one that would fire every millisecond.
