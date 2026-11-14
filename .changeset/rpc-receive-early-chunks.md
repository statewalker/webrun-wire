---
"@statewalker/webrun-rpc": patch
---

`recieve` (and so `listenBidi`, `ioHandle`, `ioSend`) no longer acknowledges and drops a chunk that arrives before the consumer starts reading its input: the reply is withheld until the chunk is taken. A handler that awaited anything before pulling its input used to lose the first chunks, or hang when the final `done` was lost too.
