# @statewalker/webrun-http-port

HTTP over `MessagePort`. Transport-agnostic — works with any port from the `webrun-port-*` family or a same-process `MessageChannel`.

Three API tiers:

- **Data layer** (`webrun-http-port`) — `httpFetch` / `httpServe` operating over envelope objects and `AsyncIterable<Uint8Array>` bodies. No `Request` / `Response` runtime types.
- **Fetch layer** (`webrun-http-port/fetch`) — `fetchOverPort` / `serveFetchOverPort` wrapping the data layer with `Request` / `Response`.
- **Site host** — `PortSiteBuilder` hosts a `SiteHandler` over a `MessagePort`. Cross-platform sibling of [`HostedSiteBuilder`](../webrun-site-host) (browser+SW); same `SiteHandler` seam.

Public framing helpers `encodeMessage` and `decodeMessage` are exported for non-`callBidi` consumers.

## PortSiteBuilder

```ts
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { PortSiteBuilder } from "@statewalker/webrun-http-port";

const handler = new SiteBuilder()
  .setEndpoint("/api/time", () => new Response(new Date().toISOString()))
  .build();

const stop = new PortSiteBuilder(remotePort).setHandler(handler).start();
// On the other side of the port, `fetchOverPort(localPort, request)` flows
// straight into `handler`. Same handler works in HostedSiteBuilder, too.
```

See [proposal](../../openspec/changes/webrun-http-port/proposal.md), [design](../../openspec/changes/webrun-http-port/design.md), and [spec](../../openspec/changes/webrun-http-port/specs/webrun-http-port/spec.md).

## License

MIT
