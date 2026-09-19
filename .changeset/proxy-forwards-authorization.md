---
"@statewalker/webrun-http-proxy": minor
---

`urlUpstream` no longer drops `authorization`. That header belongs to the application calling the upstream, and dropping it made calling an API with its own key through the proxy impossible. A system that keeps its own credential in a request header names that header in `stripRequestHeaders`, which is consumed at this hop as before. Breaking for a caller that relied on the implicit drop: add `"authorization"` to `stripRequestHeaders` to keep the old behaviour.
