---
"@statewalker/webrun-http-streams": patch
"@statewalker/webrun-http-proxy": minor
"@statewalker/webrun-http-events": minor
"@statewalker/webrun-http-browser": patch
---

One handler type across webrun-wire: `FetchHandler = (request: Request) => Response | Promise<Response>`, sync or async, as a Service Worker's or a Durable Object's `fetch`. `@statewalker/webrun-http-streams` exports it (`HttpHandler` stays as a deprecated alias) and `serveFetchOverDuplex` accepts it; `@statewalker/webrun-http-browser` re-exports it. `@statewalker/webrun-http-proxy` and `@statewalker/webrun-http-events` declare the identical type to keep zero runtime dependencies (a type test keeps them equal); their `FetchHandler` was `Promise<Response>`-only, so code that calls `.then` on one should `await` it instead.
