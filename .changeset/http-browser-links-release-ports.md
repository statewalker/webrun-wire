---
"@statewalker/webrun-http-browser": patch
---

HTTP links (`connectHttpLink` / `serveHttpLink`, so the same-origin dispatcher's links to handlers, workers' links through it, and the relay's) give every request's multiplexed port back when the exchange ends, with webrun-http-streams' fix bundled in. Before, each GET or POST whose response was read to its end kept its port, and a link stopped taking requests after 1024 of them. `HttpLinkOptions` takes `maxPorts`, the ceiling on requests in flight on a link at once (default 1024).

The bundles no longer carry the HTTP stack into code that does not use it: a page that imports only the WebSocket client (`createWebSocketClass`) bundles about 8 KB of it instead of 20 KB, the server end (`upgradeWebSocket`, `ServerWebSocket`) about 6 KB instead of 18 KB.
