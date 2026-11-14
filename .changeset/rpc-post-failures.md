---
"@statewalker/webrun-rpc": patch
---

`listenPort` no longer turns a reply it cannot post (an unclonable result or error field) into an unhandled rejection with a caller that waits until its timeout: the caller now gets a `response:error` naming the reason. `callPort` whose `postMessage` throws synchronously now rejects and removes its message and abort listeners instead of leaving them installed.
