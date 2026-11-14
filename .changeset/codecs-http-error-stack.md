---
"@statewalker/webrun-http-streams": minor
---

The `x-webrun-error` header of a 400 or 500 no longer carries the error's `stack` by default, so a peer that sends a malformed request does not learn the server's file paths. New option `includeErrorStack: true` (on `httpServe` / `serveFetchOverDuplex`) restores it.
