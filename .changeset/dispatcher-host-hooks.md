---
"@statewalker/webrun-http-browser": patch
---

The same-origin dispatcher serves hosts that route by their own rules:

- A request whose `route` declines every handler of its key, because it waits for one in particular such as a shard, now waits for attaches until `route` accepts one, up to `attachTimeoutMs`. Before, the next attach of any handler ended the wait with a 503, and after a relink round a missing handler gave a 404.
- `failure(request, { kind, error })` answers the dispatcher's own failures, `"timeout"`, `"gone"` and `"lost"`, in the host's shape. The defaults are unchanged: 503, 404 and a plain-text 502.
- `socketHeaders(headers, from)` filters what a socket's upgrade carries, by whether a page or a handler asked for it. A host drops from pages' sockets the headers only its handlers may send.
- `dispatcher.ready` settles once the keys served before a restart are read back.
- `webSocketUpgradeResponse(port, protocol)` is the 101 for a socket whose server end the handler runs itself.
