# @statewalker/webrun-http-events

## 0.2.1

### Patch Changes

- 92a3399: Stop shipping the unit tests to npm: they moved from `src/` to `tests/`. The package's tsconfig
  now extends the repository's `tsconfig.base.json`, and a `lint` script was added.
- 92a3399: Topics that need percent-encoding now work. The client percent-encodes only what the URL parser
  would mangle (`%`, `/`, `?`, `#`, a space and other characters not valid in a path segment) and
  the handler decodes the segment, so `my topic`, `a/b` or `what?` reach their subscribers and match
  a `topics` allow-list. A segment with a malformed escape answers `404 no such topic`.
  
  Every other topic keeps its old wire form (`user:42` is still `/user:42`), so a new client and an
  old handler, or the reverse, still agree on it. Topics containing `%`, `/`, `?`, `#` or spaces were
  broken before; for those, upgrade both the client and the handler.

## 0.2.0

### Minor Changes

- 1fb4bff: One handler type across webrun-wire: `FetchHandler = (request: Request) => Response | Promise<Response>`, sync or async, as a Service Worker's or a Durable Object's `fetch`. `@statewalker/webrun-http-streams` exports it (`HttpHandler` stays as a deprecated alias) and `serveFetchOverDuplex` accepts it; `@statewalker/webrun-http-browser` re-exports it. `@statewalker/webrun-http-proxy` and `@statewalker/webrun-http-events` declare the identical type to keep zero runtime dependencies (a type test keeps them equal); their `FetchHandler` was `Promise<Response>`-only, so code that calls `.then` on one should `await` it instead.

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
