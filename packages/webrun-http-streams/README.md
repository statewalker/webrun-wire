# @statewalker/webrun-http-streams

## What it is

HTTP request/response over a `Duplex` from `@statewalker/webrun-streams`. A
caller sends a standard `Request` (or a plain envelope plus body bytes) into a
`Duplex` call and gets a `Response` back. A server wraps a
`(Request) => Promise<Response>` handler as a `Duplex` that any transport
adapter can serve. The bytes on the `Duplex` are conforming HTTP/1.1 by
default. The package also ships a pair of transport-agnostic stubs that move a
structured-clonable envelope instead of bytes.

## Why it exists

A `Duplex` is one call that streams bytes in and bytes out, and every transport
adapter in this repository produces one: `@statewalker/webrun-rpc` over a
`MessagePort` or worker, `@statewalker/webrun-streams-ws`,
`@statewalker/webrun-streams-webrtc`, `@statewalker/webrun-streams-libp2p`,
`@statewalker/webrun-streams-livekit`, `@statewalker/webrun-streams-peerjs`.
This package puts HTTP on top of that seam, so an HTTP handler or a fetch-style
caller works over any of those transports without change.

The default wire format is real HTTP/1.1, not a private encoding. A peer that
is not webrun at all, such as `node:http`, can read what this package writes
and write what it reads.

## How to use

```sh
pnpm add @statewalker/webrun-http-streams
```

- **Peer dependencies:** none.
- **Runtime dependency:** `@statewalker/webrun-streams` (the `Duplex` type,
  stream helpers, error serialisation).
- **Entry point:** one, `.`. ESM only: `dist/index.js` with `dist/index.d.ts`.
  The `source` export condition points at `src/index.ts`.
- **Environment:** anything with `Request`, `Response`, `ReadableStream`,
  `TextEncoder` and `TextDecoder`: browsers, workers, service workers, Node,
  Deno, Bun. Firefox loses request-body streaming; see
  [Firefox buffers request bodies](#firefox-buffers-request-bodies).

The API comes in three layers on the `Duplex` seam, plus the stubs:

| Layer | Exports | Shape |
| --- | --- | --- |
| Data | `httpFetch`, `httpServe` | Envelope + `AsyncIterable<Uint8Array>` body. No `Request`/`Response`. |
| Fetch | `fetchOverDuplex`, `serveFetchOverDuplex` | Standard `Request` / `Response`. |
| Site host | `DuplexSiteBuilder` | Hands a `(Request) => Promise<Response>` handler to an adapter's `serve`. |
| Stubs (no `Duplex`) | `newHttpClientStub`, `newHttpServerStub` | `SerializedHttpEnvelope` over any `send` function. |

Happy path, with `@statewalker/webrun-rpc` as the transport over an in-process
`MessageChannel`:

```ts
import { connect, overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";

const channel = new MessageChannel();

// server side
const stop = await serve(
  { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
  serveFetchOverDuplex(async (request) => {
    const url = new URL(request.url);
    return Response.json({ path: url.pathname, method: request.method });
  }),
);

// client side
const { call, close } = await connect({
  mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator" }),
});
const response = await fetchOverDuplex(call, new Request("http://local/api/todo/7"));

console.log(response.status); // 200
console.log(await response.json()); // { path: "/api/todo/7", method: "GET" }

await close();
await stop();
```

Swap the transport adapter and nothing else changes. A `Response` whose body is
a `ReadableStream` streams across chunk by chunk, so server-sent events work
over a `MessagePort` or a WebRTC link.

## Examples

### Data layer: `httpFetch` / `httpServe`

```ts
import { httpFetch, httpServe } from "@statewalker/webrun-http-streams";

// A Duplex is `(input) => AsyncGenerator<Uint8Array>`, so the server side is a
// usable `call` with no transport at all: the cheapest way to test a handler.
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

Signatures: `httpFetch(call, env, body?, { codec? })` and
`httpServe(handler, { codec? })`. Over a real transport, `call` comes from an
adapter's `connect` and `httpServe(...)` goes to its `serve`.

A relative `url` works but does not survive the round trip verbatim. HTTP/1.1
origin-form carries no scheme or authority, so the decoder rebuilds an
absolute url from the codec's `scheme` and `host` options: `url: "/api/time"`
reaches the handler as `http://localhost/api/time` unless you configure the
codec.

### Fetch layer: `fetchOverDuplex` / `serveFetchOverDuplex`

```ts
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";

const call = serveFetchOverDuplex(
  async (request) => new Response(`hello ${new URL(request.url).pathname}`),
);
const response = await fetchOverDuplex(call, new Request("http://peer.test/api/time"));
await response.text(); // "hello /api/time"
```

Both take an optional last argument `{ codec }`. `fetchOverDuplex` plumbs
`request.signal` into body iteration, so aborting the signal ends the call. An
already-aborted signal rejects before anything is sent.

### Site host: `DuplexSiteBuilder`

```ts
import { DuplexSiteBuilder } from "@statewalker/webrun-http-streams";
import { overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";

const siteHandler = async (request: Request) =>
  new Response(`site ${new URL(request.url).pathname}`);
const { port2 } = new MessageChannel();

const stop = await new DuplexSiteBuilder()
  .setHandler(siteHandler)
  .start(serve, { mux: overPipe(port2, { codec: structuredCodec, side: "responder" }) });
// later: await stop();
```

`start(serve, params)` accepts any adapter's `Serve<P>` together with its
params. `.setCodec(codec)` pins the wire format. The builder holds no site
configuration: endpoints, files and auth belong to whatever produced the
handler. `SiteHandler` is exported as the structural type
`(request: Request) => Promise<Response>`, so this package does not depend on
any site-builder package. Calling `start()` before `setHandler()` rejects with
`DuplexSiteBuilder.start: setHandler(handler) must be called before start()`.

### Transport-agnostic stubs: `newHttpClientStub` / `newHttpServerStub`

These do not use the `Duplex` seam. They move a `SerializedHttpEnvelope`
(`{ options, content }`: plain request or response options plus a body
iterable) over whatever `send` function you give them. A `MessagePort` can
structured-clone that envelope directly, so it never needs a byte encoding.
`@statewalker/webrun-http-browser` builds its ServiceWorker transport on this
pair.

```ts
import { newHttpClientStub, newHttpServerStub } from "@statewalker/webrun-http-streams";

const server = newHttpServerStub(async (request) => new Response(`echo ${await request.text()}`));
const client = newHttpClientStub(server); // `send` is anything envelope-in, envelope-out

const res = await client(new Request("http://peer.test/x", { method: "POST", body: "hi" }));
await res.text(); // "echo hi"
```

A `send` that resolves `undefined` (no service for this call) becomes a `404`
on the client side.

### Choosing a codec

```ts
import {
  defaultCodec,
  httpCodec,
  httpFetch,
  jsonEnvelopeCodec,
  newHttpCodec,
  newSniffingCodec,
} from "@statewalker/webrun-http-streams";

// default: writes HTTP/1.1, accepts HTTP/1.1 or the JSON envelope
await httpFetch(call, env);

// pinned
await httpFetch(call, env, undefined, { codec: httpCodec });

// the scheme and authority are not on the HTTP/1.1 wire; supply them here
const codec = newHttpCodec({ scheme: "https", host: "peer.test" });

// your own write/accept combination
const strict = newSniffingCodec({ write: httpCodec, accept: [httpCodec] });
```

| `newHttpCodec` option | Default | Meaning |
| --- | --- | --- |
| `scheme` | `"http"` | Scheme used to rebuild an absolute url on decode. Configuration, not wire data: a peer configured `http` rebuilds an `https` url as `http`. |
| `host` | `"localhost"` | Authority used when a url carries none. Also fills the mandatory `Host` header. |
| `maxHeaderBytes` | `65536` | Bound on the whole head section, start line included. |

`httpCodec` is `newHttpCodec()` with those defaults. `defaultCodec`, used
whenever no `codec` option is given, is
`newSniffingCodec({ write: httpCodec, accept: [httpCodec, jsonEnvelopeCodec] })`.

`jsonEnvelopeCodec` is a second format: `JSON.stringify(envelope)`, a newline,
then the body bytes. `encodeMessage` / `decodeMessage` expose that framing for
any envelope type. A server answers in whichever format read the request, so a
peer that speaks only the JSON envelope is answered as a JSON envelope.

### Telling a malformed message from a broken transport

```ts
import { httpFetch } from "@statewalker/webrun-http-streams";

try {
  await httpFetch(call, env);
} catch (err) {
  if ((err as Error).name === "HttpParseError") {
    // malformed bytes: one side or an intermediary is at fault
  } else {
    throw err; // transport failure, or the peer handler's own error
  }
}
```

Check `err.name`, not `instanceof`; see
[Errors cross the wire as responses](#errors-cross-the-wire-as-responses).

### Exports

| Export | What it is |
| --- | --- |
| `httpFetch`, `httpServe` | Data layer. Types: `HttpDataHandler`, `HttpDataHandlerResult`, `HttpDataOptions`, `HttpFetchResult`. |
| `fetchOverDuplex`, `serveFetchOverDuplex` | Fetch layer. |
| `DuplexSiteBuilder`, `SiteHandler` | Site host over an adapter's `Serve<P>`. |
| `newHttpClientStub`, `newHttpServerStub` | Transport-agnostic stubs. Types: `HttpHandler`, `SerializedHttpEnvelope`, `SerializedHttpRequest`, `SerializedHttpResponse`. |
| `defaultCodec`, `httpCodec`, `newHttpCodec`, `HttpCodecOptions` | HTTP/1.1 codec and the default sniffing codec. |
| `jsonEnvelopeCodec`, `encodeMessage`, `decodeMessage` | JSON-envelope format. |
| `newSniffingCodec`, `SniffingCodecOptions` | Build a write/accept combination. |
| `HttpParseError` | Every codec refusal. |
| `HttpError`, `HttpErrorOptions` | Status-carrying error for handlers; not wired into the wire format. |
| `PEER_ERROR_HEADER` | `"x-webrun-error"`. |
| `MessageCodec`, `ByteSource`, `RequestEnvelope`, `ResponseEnvelope`, `DecodedRequest`, `DecodedResponse`, `ResponseCodecOptions` | The codec seam's types. |

## Internals

### One HTTP/1.1 message per `Duplex` call

```
caller                                     Duplex                                server
Request -> envelope+body -> encodeRequest  ==bytes==>  decodeRequest -> envelope+body -> handler
Response <- envelope+body <- decodeResponse <==bytes==  encodeResponse <- envelope+body <-'
```

```
POST /api?a=1 HTTP/1.1
Host: peer.test
Connection: close
Transfer-Encoding: chunked

5
hello
0

```

`Connection: close` is always emitted, and bytes after a complete message are
an error (`N trailing bytes after a complete message`). Running several calls
at once is the transport adapter's job, not the codec's. Bodies use
`Content-Length` when the caller declares one and chunked transfer coding
otherwise. The codec is tested against `node:http` in both directions
(`tests/http1-node-interop.test.ts`).

### The codec refuses instead of guessing

Every ambiguity is an `HttpParseError`. Some that a reader meets in practice:

- a message with both `Content-Length` and `Transfer-Encoding`:
  `message declares both Content-Length and Transfer-Encoding; refusing (request smuggling)`;
- a head larger than `maxHeaderBytes`: `head section exceeds 65536 bytes`;
- obsolete line folding: `obs-fold header continuation is not accepted`;
- an HTTP/1.1 request without `Host`: `HTTP/1.1 request has no Host header`;
- a header value that is not latin-1, or that contains CR, LF or a control
  character.

RFC 9112 §2.2 lets a recipient ignore a single CRLF before the request line.
This codec does not: it answers `400 Bad Request` with
`malformed request line`.

### Format sniffing needs no handshake

The formats identify themselves by their first byte. A JSON envelope always
begins with `{`, which is not an HTTP token character, and every HTTP start
line (a method, or `HTTP/1.1`) begins with one. The sniffing codec peeks one
byte and picks the first accepted codec that claims it. An empty stream fails
with `sniff: stream ended before any bytes arrived`; an unknown first byte
fails with `sniff: no accepted codec recognises a message starting with byte 0x..`.

### Bodyless responses carry no bytes

Responses with a null-body status (204, 205, 304) and responses to `HEAD` or
`OPTIONS` put no body bytes on the wire, even if the handler's `Response` has a
body stream; the handler's stream is cancelled. The reader gets
`new Response(null, init)`, whose `.body` is `null`.

The null-body set also contains 101 and 103, but `fetchOverDuplex` cannot
return them: `ResponseInit.status` must be 200–599, so the `Response`
constructor throws a `RangeError` (`init["status"] must be in the range of 200
to 599, inclusive.` in Node) if a peer answers with one. Use `httpFetch` to see
an informational status.

Known gap: for these bodyless responses `fetchOverDuplex` does not release the
underlying `Duplex` call. `httpFetch` returns only `{ envelope, body }`, and
`.return()` on a body generator nobody has pulled from is a no-op, so the
producer's `finally` does not run. On a transport that multiplexes calls with a
bounded stream table this holds one slot per such call. Closing it needs
`httpFetch` to expose the call for cancellation.

### Hop-by-hop headers are dropped at the fetch layer

The codec surfaces every header verbatim. The fetch layer strips `connection`,
`host`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`,
`trailer`, `transfer-encoding` and `upgrade` in both directions. They mean
nothing to a `Request`/`Response`, and a relay that re-emitted them would
corrupt its own framing.

### Errors cross the wire as responses

A real HTTP peer cannot receive a JavaScript exception, only a response or a
connection that ends with no status. So the server answers on the wire wherever
it can:

| Situation | On the wire | What a webrun caller sees |
| --- | --- | --- |
| Handler throws | `500 Internal Server Error`, message in the body | `httpFetch` rejects with the peer's error; `name`, `message`, `stack` and custom fields preserved |
| Request cannot be parsed | `400 Bad Request`, reason in the body | `httpFetch` rejects with the parse error |
| Transport fails | nothing | the transport error propagates unchanged |

Both error responses carry the serialised error in the `x-webrun-error` header
(`PEER_ERROR_HEADER`). A webrun peer re-throws it; any other client reads a
normal response. The header value is escaped to printable ASCII and capped at
4096 characters. Without the cap a huge message would push the head past the
reader's `maxHeaderBytes`, and the caller would see
`head section exceeds 65536 bytes` instead of the real error. On this path the
caller also cancels the `Duplex` output, which frees the call's slot on a
multiplexing transport.

`instanceof HttpParseError` holds only when this side's decoder refused the
peer's bytes. When the peer refuses your request, its 400 comes back through
the header, and `deserializeError` builds a plain `Error` with the original
`name`, `message`, `stack` and fields, not the original class. The same is true
of every error class crossing this boundary, including your handler's own
`Error` subclasses. A refusal is answered in the format the peer was speaking.

`HttpError` is a separate helper for handlers that want to carry a status
(`HttpError.errorResourceNotFound()`, `errorForbidden()`, `errorResourceGone()`,
`errorInternalError()`, `fromError()`). The wire format does not read it:
throwing one produces a 500 like any other exception.

### Firefox buffers request bodies

Firefox does not implement `Request.prototype.body` (checked against Firefox
146). Without it, `new Request(url, { body: stream })` does not reject a
`ReadableStream`; it stores the literal text `[object ReadableStream]`. The
package detects this with a capability probe
(`Object.getOwnPropertyDescriptor(Request.prototype, "body")`), evaluated per
call, not a user-agent test.

- **Sending** (`fetchOverDuplex`, `newHttpClientStub`): the whole payload is
  read with `request.arrayBuffer()` before it goes on the wire.
- **Receiving** (`serveFetchOverDuplex`, `newHttpServerStub`): the request body
  is drained into one buffer before the handler's `Request` is built. Without
  this the handler would read `[object ReadableStream]` and answer 200 with
  corrupt data.

So on Firefox a 1 GiB upload is a 1 GiB allocation, where Chromium and Node
stream it. Response streaming is unaffected. Safari is untested: it has
`Request.body`, but only accepts a stream as `init.body` from Technology
Preview 250, so a shipping Safari takes the streaming branch here.

Buffering cannot tell an absent body from an empty one. Chromium frames an
empty POST body on the wire; the Firefox path sends none. Both decode to the
same empty body at the far end.

### Stub bodies must be productive

`SerializedHttpEnvelope.content` must yield or finish on its own. A body neither
stub may read (a GET/HEAD/OPTIONS request, a null-body-status response) is
released by pulling once and then calling `.return()`, because `.return()` on a
generator that has not started is a no-op and would leak the producer. A
`content` that blocks forever without yielding makes the stub block with it.
A `content` that waits on a peer that may never send should carry its own
timeout.

### Dependencies

One runtime dependency, `@statewalker/webrun-streams`, for the `Duplex` and
`Serve` types, `fromReadableStream` / `toReadableStream`, and
`serializeError` / `deserializeError`. No peer dependencies. Everything else is
platform API.

### Scripts

```sh
pnpm test             # vitest run
pnpm run build        # rolldown + tsc --emitDeclarationOnly
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # biome check src tests
```

`tests/readme-examples.test.ts` runs the snippets in this file against the
source.

## License

MIT
