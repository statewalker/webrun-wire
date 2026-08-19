# @statewalker/webrun-http-streams

HTTP request / response over a `Duplex` from any `webrun-streams-*` adapter. Replaces `webrun-http` + `webrun-http-port`.

## Three layers

### Data layer — `httpFetch` / `httpServe`

```ts
import { httpFetch, httpServe } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-ws";

const { call } = await connect({ url });
const { envelope, body } = await httpFetch(call, {
  url: "/api/time",
  method: "GET",
  headers: [],
});
```

`httpServe(handler)` returns a `Duplex` you can hand to any adapter's `serve(...)`.

### Fetch layer — `fetchOverDuplex` / `serveFetchOverDuplex`

```ts
const response = await fetchOverDuplex(call, new Request("/api/time"));
```

`serveFetchOverDuplex(handler)` adapts a `(Request) => Promise<Response>` handler.

### Site host — `DuplexSiteBuilder`

```ts
import { DuplexSiteBuilder } from "@statewalker/webrun-http-streams";
import { serve } from "@statewalker/webrun-streams-port";

const stop = await new DuplexSiteBuilder()
  .setHandler(siteHandler)
  .start(serve, { port });
```

`DuplexSiteBuilder` is the cross-platform sibling of `HostedSiteBuilder` (browser+SW) — same `SiteHandler` seam, different transport.

## Wire format

Conforming **HTTP/1.1** by default — a `Duplex` carries bytes a real HTTP
implementation can parse, and accepts bytes a real HTTP implementation
produces. Verified against `node:http` in both directions.

```
POST /api?a=1 HTTP/1.1
Host: peer.test
Connection: close
Transfer-Encoding: chunked

5
hello
0

```

One message per `Duplex` call: `Connection: close` is always emitted, and bytes
after a complete message are an error. Bodies use `Content-Length` when the
caller declares one and chunked transfer coding otherwise; a message declaring
both is refused.

The codec is deliberately strict: every ambiguity is a refusal rather than a
guess. One consequence worth calling out explicitly — RFC 9112 §2.2 permits a
recipient to *tolerate* a single leading CRLF sent before the request-line
("SHOULD ignore"). This codec declines that leniency and refuses it as a
malformed request line; see ADR-0006.

### Choosing a codec

```ts
import { httpCodec, jsonEnvelopeCodec, newHttpCodec } from "@statewalker/webrun-http-streams";

// default: writes HTTP/1.1, accepts HTTP/1.1 or the legacy JSON envelope
await httpFetch(call, env);

// pinned
await httpFetch(call, env, body, { codec: httpCodec });

// the scheme is not on the HTTP/1.1 wire; supply it here
const codec = newHttpCodec({ scheme: "https", host: "peer.test" });
```

The previous format — `<JSON.stringify(envelope)>` + newline + body bytes —
remains available as `jsonEnvelopeCodec`, and readers accept it automatically,
so the two ends of a peer pair can be upgraded in either order. A server
answers in whichever format read the request. See ADR-0006.

## Errors

The codec answers on the wire wherever it can, because a real HTTP peer cannot
receive a JavaScript exception — only a response, or a connection that ends
with no status.

| Situation | On the wire | On a webrun caller |
| --- | --- | --- |
| Handler throws | `500 Internal Server Error`, message in the body | `httpFetch` rejects with the peer's error, stack and custom fields preserved |
| Request cannot be parsed | `400 Bad Request`, reason in the body | `httpFetch` rejects with the parse error |
| Transport fails | nothing — the failure is not ours to answer | the error propagates unchanged |

Both error responses carry the serialized error in an `x-webrun-error` header
(exported as `PEER_ERROR_HEADER`), which is what lets a webrun peer re-throw a
real `Error` rather than a status code. A third party just reads a conforming
response and ignores the header.

Refusals are always `HttpParseError`, whichever codec read the message, so a
consumer can tell "the peer sent something malformed" from "the transport
broke":

```ts
import { HttpParseError } from "@statewalker/webrun-http-streams";

try {
  await httpFetch(call, env);
} catch (err) {
  if (err instanceof HttpParseError) {
    // malformed bytes — the peer or an intermediary is at fault
  } else {
    throw err; // transport failure, or the peer handler's own error
  }
}
```

A refusal is answered in whatever format the peer was speaking, so a caller
pinned to the legacy envelope receives its 400 as an envelope rather than as
HTTP/1.1.

`HttpError` is a separate, unrelated helper for handlers that want to raise a
status deliberately (`HttpError.errorResourceNotFound()` and friends). It is
not wired into the wire format: throwing one produces a 500 like any other
exception.

## License

MIT
