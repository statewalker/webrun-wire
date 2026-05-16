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

`<JSON.stringify(envelope)>\n<body bytes…>` — newline-delimited JSON header followed by raw body bytes. Same shape as the legacy `webrun-http-port` so a future bridging adapter could interop.

## License

MIT
