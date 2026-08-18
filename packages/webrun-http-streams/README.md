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

## License

MIT
