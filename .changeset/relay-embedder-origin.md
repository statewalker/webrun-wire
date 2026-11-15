---
"@statewalker/webrun-http-browser": minor
---

Relay mode tells embedders apart by origin (#129). The relay iframe stamps the embedder's origin into every `REGISTER`, `UNREGISTER` and `CONNECT` it bridges, as `params.origin`. The worker passes it to `canRegister` (a new fourth argument) and to a new `canConnect` option, which can refuse a `CONNECT` before it reaches the service; `onlyRegistrantOrigin` keeps each embedder's services to that embedder, and the registrant's origin is kept in the registry. `getRelayWindowMessageHandler` gets `allowedOrigins` and `canConnect` options that refuse an embedder outright. The README documents that by default every embedder can reach every service, and `demo/demo-2.html` now serves the folder under a random key. Defaults are unchanged.
