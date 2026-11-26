---
"@statewalker/webrun-rpc": patch
---

`throughAbort` returns its source when its consumer stops early without an abort (a `break`, or a chunk send that rejected because the port closed), so a `listenBidi` producer suspended at `yield` runs its `finally` instead of leaking its listeners and timers (#216).
