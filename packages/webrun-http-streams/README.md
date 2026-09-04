# @statewalker/webrun-http-streams

HTTP request / response over a `Duplex` from any `webrun-streams-*` adapter.
Replaces the retired `webrun-http` + `webrun-http-port` packages.

## Install

```sh
npm install @statewalker/webrun-http-streams
```

One runtime dependency, [`@statewalker/webrun-streams`](../webrun-streams); no
peer dependencies. ESM only (`"type": "module"`). Needs standard `Request`,
`Response`, `ReadableStream`, `TextEncoder` and `TextDecoder` — present in
browsers, Node 18+, Deno, Bun and Cloudflare Workers.

Pair it with a transport adapter to get a `Duplex`:
[`-ws`](../webrun-streams-ws), [`-port`](../webrun-streams-port),
[`-webrtc`](../webrun-streams-webrtc), [`-libp2p`](../webrun-streams-libp2p),
[`-livekit`](../webrun-streams-livekit), [`-peerjs`](../webrun-streams-peerjs).

## Getting started

Pick a transport, then move standard `Request` / `Response` objects across it.
Here the transport is an in-process `MessageChannel`, so the whole exchange runs
in one process with no network:

```ts
import { connect, serve } from "@statewalker/webrun-streams-port";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";

// --- server side ---
const channel = new MessageChannel();
const stop = await serve(
  { port: channel.port2 },
  serveFetchOverDuplex(async (request) => {
    const url = new URL(request.url);
    return Response.json({ path: url.pathname, method: request.method });
  }),
);

// --- client side ---
const { call, close } = await connect({ port: channel.port1 });
const response = await fetchOverDuplex(call, new Request("http://local/api/todo/7"));

console.log(response.status);        // 200
console.log(await response.json());  // { path: "/api/todo/7", method: "GET" }

await close();
await stop();
```

Swap `@statewalker/webrun-streams-port` for
[`-ws`](../webrun-streams-ws), [`-webrtc`](../webrun-streams-webrtc),
[`-libp2p`](../webrun-streams-libp2p), [`-livekit`](../webrun-streams-livekit)
or [`-peerjs`](../webrun-streams-peerjs) and nothing else changes — that is the
whole point of the `Duplex` seam.

Streaming bodies work as you would expect: a `Response` whose body is a
`ReadableStream` streams across the transport chunk by chunk, which is what
makes server-sent events work over a `MessagePort` or a WebRTC link.

## Layers

Three of them sit on the `Duplex` seam, plus one older transport-agnostic pair
that predates it and is kept for `webrun-http-browser`.

### Data layer — `httpFetch` / `httpServe`

Envelopes and body iterators, no `Request`/`Response` involved.

```ts
import { httpFetch, httpServe } from "@statewalker/webrun-http-streams";

// `call` is a Duplex. In-process it can be the handler itself; over a
// transport it comes from an adapter's `connect`:
//   const { call } = await connect({ url });   // webrun-streams-ws
const call = httpServe(async (env, body) => {
  for await (const _chunk of body) {
    /* drain the request body */
  }
  return {
    envelope: { status: 200, statusText: "OK", headers: [["content-type", "text/plain"]] },
    body: [new TextEncoder().encode(`hello ${new URL(env.url).pathname}`)],
  };
});

const { envelope, body } = await httpFetch(call, {
  url: "http://peer.test/api/time",
  method: "GET",
  headers: [],
});
// envelope.status === 200; `body` is an AsyncIterable<Uint8Array>
```

`httpServe(handler)` returns a `Duplex` you can hand to any adapter's
`serve(...)`. Because a `Duplex` is just `(input) => AsyncGenerator<Uint8Array>`,
the handler side *is* a usable `call` with no transport at all — that is what
the snippet above does, and it is the cheapest way to test a handler.

A relative `url` in the envelope works, but note it does not survive the round
trip verbatim: HTTP/1.1 origin-form carries no scheme or authority, so the
decoder rebuilds an absolute url from the codec's `scheme`/`host` options.
`url: "/api/time"` arrives at the handler as `http://localhost/api/time` unless
you configure the codec (see below).

### Fetch layer — `fetchOverDuplex` / `serveFetchOverDuplex`

The same thing in terms of standard `Request` / `Response`.

```ts
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";

const call = serveFetchOverDuplex(
  async (request) => new Response(`hello ${new URL(request.url).pathname}`),
);
const response = await fetchOverDuplex(call, new Request("http://peer.test/api/time"));
await response.text(); // "hello /api/time"
```

Hop-by-hop headers (`connection`, `transfer-encoding`, `host`, …) are stripped
in both directions: the codec surfaces them verbatim, but they are meaningless
to a `Request`/`Response` and re-emitting them from a relay would corrupt its
framing.

`fetchOverDuplex` plumbs `request.signal` into body iteration, so aborting the
signal terminates the call.

### Site host — `DuplexSiteBuilder`

```ts
import { DuplexSiteBuilder } from "@statewalker/webrun-http-streams";
import { serve } from "@statewalker/webrun-streams-port";

const stop = await new DuplexSiteBuilder()
  .setHandler(siteHandler) // (Request) => Promise<Response>
  .start(serve, { port });
// later: await stop();
```

`.setCodec(codec)` pins the wire format. `DuplexSiteBuilder` is the
cross-platform sibling of `HostedSiteBuilder` (browser + ServiceWorker) — same
`SiteHandler` seam, different transport. It holds no site configuration of its
own; endpoints, files and auth belong to the `SiteHandler` producer (typically
`SiteBuilder`).

> Not runnable as written above: it needs a live `MessagePort` and
> `@statewalker/webrun-streams-port`, which this package does not depend on.
> `start` accepts any `Serve<P>`, so an in-process one is enough to exercise
> it. Calling `start()` before `setHandler()` throws.

### Transport-agnostic stubs — `newHttpClientStub` / `newHttpServerStub`

Predates the `Duplex` seam and does **not** use it. Instead of bytes on a wire,
these move a `SerializedHttpEnvelope` — a plain options object plus a body
iterable — over whatever `send` function you give them. `webrun-http-browser`
is built on this pair, because a MessagePort can structured-clone the envelope
directly and never needs a byte encoding.

```ts
import { newHttpClientStub, newHttpServerStub } from "@statewalker/webrun-http-streams";

const server = newHttpServerStub(async (request) => new Response(`echo ${await request.text()}`));
const client = newHttpClientStub(server); // `send` is anything envelope-in, envelope-out

const res = await client(new Request("http://peer.test/x", { method: "POST", body: "hi" }));
await res.text(); // "echo hi"
```

A `send` that resolves `undefined` — no service registered for this call —
becomes a `404` on the client side. `SerializedHttpEnvelope.content` must be
*productive*: it has to yield or finish on its own, because a body neither stub
is allowed to read is released by draining it, not by a bare `.return()`.

Use the `Duplex` layers for anything new. These stay because the browser
package's MessagePort transport is built around them.

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

### Bodyless messages

Responses with a null-body status — **204, 205, 304** — and responses to `HEAD`
or `OPTIONS` put no bytes on the wire, in both directions, even if the
handler's `Response` carries a body stream. The handler's stream is cancelled
rather than sent. On the reading side you get `new Response(null, init)`, whose
`.body` is `null`.

The internal null-body set also lists 101 and 103, but neither is reachable
through the fetch layer: `ResponseInit.status` must be 200–599, so
`fetchOverDuplex` throws a `TypeError` from the `Response` constructor if a
peer answers with one. Use the data layer (`httpFetch`) if you need to see an
informational status.

### Choosing a codec

```ts
import {
  defaultCodec,
  httpCodec,
  jsonEnvelopeCodec,
  newHttpCodec,
  newSniffingCodec,
} from "@statewalker/webrun-http-streams";

// default: writes HTTP/1.1, accepts HTTP/1.1 or the legacy JSON envelope
await httpFetch(call, env);

// pinned
await httpFetch(call, env, body, { codec: httpCodec });

// the scheme and authority are not on the HTTP/1.1 wire; supply them here
const codec = newHttpCodec({ scheme: "https", host: "peer.test" });
```

| `newHttpCodec` option | Default | Meaning |
| --- | --- | --- |
| `scheme` | `"http"` | Scheme used to rebuild an absolute url on decode. Configuration, not wire data — a peer configured `http` rebuilds an `https` url as `http`. |
| `host` | `"localhost"` | Authority used when a url carries none. Also fills the mandatory `Host` header. |
| `maxHeaderBytes` | `65536` | Bound on the whole head section, start line included. |

`httpCodec` is `newHttpCodec()` with those defaults. `defaultCodec` — used
whenever no `codec` option is supplied — is
`newSniffingCodec({ write: httpCodec, accept: [httpCodec, jsonEnvelopeCodec] })`.

The previous format — `<JSON.stringify(envelope)>` + newline + body bytes —
remains available as `jsonEnvelopeCodec` (and as the raw `encodeMessage` /
`decodeMessage` pair), and readers accept it automatically, so the two ends of
a peer pair can be upgraded in either order. A server answers in whichever
format read the request. Sniffing needs no handshake because the formats are
self-identifying: a JSON envelope always begins `{`, which is not a token
character and so can never begin an HTTP start-line. See ADR-0006.

## Browser support

Everything here is built on `Request`, `Response`, `ReadableStream`,
`TextEncoder` and `TextDecoder`. Browsers do **not** behave uniformly, and one
difference is large enough to change what this package can do.

**Firefox does not implement `Request.prototype.body`** (checked against
Firefox 146). `Object.getOwnPropertyDescriptor(Request.prototype, "body")` is
`null` — the accessor is genuinely absent — and because a `ReadableStream` is
then not a recognised `BodyInit`, `new Request(url, { body: stream })` falls
through to the string branch and stores the literal text
`[object ReadableStream]`.

Both directions have a fallback, and both cost the same thing:

- **Sending** (`fetchOverDuplex`, `newHttpClientStub`) — with no
  `request.body` to stream from, the whole payload is buffered with
  `request.arrayBuffer()` before it goes on the wire.
- **Receiving** (`serveFetchOverDuplex`, `newHttpServerStub`) — the request
  body is drained into one contiguous buffer before the `Request` handed to
  your handler is constructed. Without this the handler would silently read the
  string `[object ReadableStream]` and answer `200` with corrupt data.

So on Firefox: **request streaming does not happen**. A 1 GiB upload from a
Firefox page is a 1 GiB allocation, where Chromium and Node stream it chunk by
chunk. Response streaming is unaffected — `Response.body` exists everywhere.

The check is a capability probe, not a user-agent test, so it flips on its own
the day Firefox ships request streams. Safari is untested and is the case to
look at first if a report arrives: it has had `Request.body` since 11.1 but
only accepts a stream as `init.body` from Technology Preview 250, so a shipping
Safari has the reader half without the upload half and takes the streaming
branch here.

One further divergence, on the sending side only: buffering cannot distinguish
an absent body from an empty one. Chromium's
`new Request(url, { method: "POST", body: "" })` yields a non-null empty
stream, so an empty body is framed on the wire; on the Firefox path a
zero-length `arrayBuffer()` is indistinguishable from no body and none is sent.
Both decode to the same empty body at the far end, so only the framing differs.
This does not arise for the stubs, whose envelope always carries a `content`
iterable.

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
response and ignores the header. The header value is bounded at 4096
characters, so a very large error message is truncated rather than blowing past
`maxHeaderBytes` at the reader.

Refusals are always `HttpParseError`, whichever codec read the message, so a
consumer can tell "the peer sent something malformed" from "the transport
broke". **Check `err.name`, not `instanceof`** — the two cases differ:

```ts
import { httpFetch } from "@statewalker/webrun-http-streams";

try {
  await httpFetch(call, env);
} catch (err) {
  if ((err as Error).name === "HttpParseError") {
    // malformed bytes — one side or an intermediary is at fault
  } else {
    throw err; // transport failure, or the peer handler's own error
  }
}
```

`instanceof HttpParseError` holds only when *this* side's decoder refused what
the peer sent. When the peer refuses **your** request, its 400 travels back
through the `x-webrun-error` header and is rehydrated by `deserializeError`,
which builds a plain `Error` carrying the original `name`, `message`, `stack`
and custom fields — not the original class. So `err.name` is
`"HttpParseError"` in both directions, and `instanceof` is true in only one.
The same applies to every error class crossing this boundary, including your
own handler's `Error` subclasses.

A refusal is answered in whatever format the peer was speaking, so a caller
pinned to the legacy envelope receives its 400 as an envelope rather than as
HTTP/1.1.

`HttpError` is a separate, unrelated helper for handlers that want to raise a
status deliberately (`HttpError.errorResourceNotFound()` and friends). It is
not wired into the wire format: throwing one produces a 500 like any other
exception.

## Exports

| Export | What it is |
| --- | --- |
| `httpFetch`, `httpServe` | Data layer. Types: `HttpDataHandler`, `HttpDataHandlerResult`, `HttpDataOptions`, `HttpFetchResult`. |
| `fetchOverDuplex`, `serveFetchOverDuplex` | Fetch layer. |
| `DuplexSiteBuilder`, `SiteHandler` | Site host over a `Connect`/`Serve` pair. |
| `newHttpClientStub`, `newHttpServerStub` | Transport-agnostic stubs. Types: `HttpHandler`, `SerializedHttpEnvelope`, `SerializedHttpRequest`, `SerializedHttpResponse`. |
| `defaultCodec`, `httpCodec`, `newHttpCodec`, `HttpCodecOptions` | HTTP/1.1 codec and the default sniffing codec. |
| `jsonEnvelopeCodec`, `encodeMessage`, `decodeMessage` | Legacy JSON-envelope format. |
| `newSniffingCodec`, `SniffingCodecOptions` | Build your own write/accept combination. |
| `HttpParseError` | Every codec refusal. |
| `HttpError`, `HttpErrorOptions` | Status-raising helper for handlers; not wired into the wire format. |
| `PEER_ERROR_HEADER` | `"x-webrun-error"`. |
| `MessageCodec`, `ByteSource`, `RequestEnvelope`, `ResponseEnvelope`, `DecodedRequest`, `DecodedResponse`, `ResponseCodecOptions` | The codec seam's types. |

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` seam, chunk collectors and error serialisation. |

No peer dependencies and no runtime dependencies outside the workspace. Relies
on the platform for `Request`, `Response`, `ReadableStream`, `TextEncoder` and
`TextDecoder`.

Downstream consumers in this workspace:
[`webrun-http-browser`](../webrun-http-browser) and
[`webrun-rpc-http`](../webrun-rpc-http).

## Scripts

```sh
pnpm test        # vitest run
pnpm run build   # rolldown + tsc --emitDeclarationOnly
pnpm lint        # biome check src tests
```

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
