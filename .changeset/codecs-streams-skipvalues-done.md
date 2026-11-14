---
"@statewalker/webrun-streams": patch
---

`newAsyncGenerator(init, true)`: a queued `done(error?)` is no longer dropped when a value is pushed after it. The consumer now sees the completion and its error; the later value resolves `false`.
