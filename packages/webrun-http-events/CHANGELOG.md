# @statewalker/webrun-http-events

## 0.2.0

### Minor Changes

- 1fb4bff: One handler type across webrun-wire: `FetchHandler = (request: Request) => Response | Promise<Response>`, sync or async, as a Service Worker's or a Durable Object's `fetch`. `@statewalker/webrun-http-streams` exports it (`HttpHandler` stays as a deprecated alias) and `serveFetchOverDuplex` accepts it; `@statewalker/webrun-http-browser` re-exports it. `@statewalker/webrun-http-proxy` and `@statewalker/webrun-http-events` declare the identical type to keep zero runtime dependencies (a type test keeps them equal); their `FetchHandler` was `Promise<Response>`-only, so code that calls `.then` on one should `await` it instead.

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
