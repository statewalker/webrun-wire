---
"@statewalker/webrun-streams": patch
---

`deserializeError` copies the payload key by key and skips `__proto__` and `constructor`, so a peer can no longer choose the prototype of the rejected error (it is always an `instanceof Error`).
