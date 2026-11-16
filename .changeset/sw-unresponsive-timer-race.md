---
"@statewalker/webrun-http-browser": patch
---

`SwHttpAdapter.start()`: a controlling worker that never answers the handshake now always rejects with `ServiceWorkerControlError` (`reason: "unresponsive"`). When control came at once (a page that loaded controlled, or Firefox activating and claiming within a millisecond of `register()`), the attach call's own timeout could fire before `start()`'s deadline and reject with a plain `Error: No answer to UPDATE_COMMUNICATION_PORT within … ms`.
