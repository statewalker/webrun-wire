# @statewalker/webrun-http-port

HTTP over `MessagePort`. Transport-agnostic — works with any port from the `webrun-port-*` family or a same-process `MessageChannel`.

Two API tiers:

- **Data layer** (`webrun-http-port`) — `httpFetch` / `httpServe` operating over envelope objects and `AsyncIterable<Uint8Array>` bodies. No `Request` / `Response` runtime types.
- **Fetch layer** (`webrun-http-port/fetch`) — `fetchOverPort` / `serveFetchOverPort` wrapping the data layer with `Request` / `Response`.

Public framing helpers `encodeMessage` and `decodeMessage` are exported for non-`callBidi` consumers.

See [proposal](../../openspec/changes/webrun-http-port/proposal.md), [design](../../openspec/changes/webrun-http-port/design.md), and [spec](../../openspec/changes/webrun-http-port/specs/webrun-http-port/spec.md).

## License

MIT
