---
"@statewalker/webrun-http-browser": patch
---

`ServerWebSocket` (and `upgradeWebSocket`) take `watch: "first-ping"`: the heartbeat watch starts with the client's first ping instead of at once. A peer that never pings, such as the other end of a pair kept in the same realm, is then never closed with 1006 for its silence. Once pings have started, a socket whose pings stop still closes. The default, `"open"`, keeps today's behaviour.
