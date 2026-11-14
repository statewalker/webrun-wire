---
"@statewalker/webrun-streams-conformance": minor
---

Two new L3 cases, run by every adapter: a handler that reads its input while the caller cancels (its `finally` must run), and while the caller's input throws (its read must throw that error, not end cleanly) (#124, #141).
