# @statewalker/webrun-site-host

Browser-side host for a `SiteHandler`. Registers a same-origin ServiceWorker,
mounts the handler under a virtual path, and rewrites incoming requests to
site-relative form before dispatching.

This package owns *where* a site runs (browser + SW). It does NOT own *what*
the site does — endpoints, files, auth, and routing live in
[`@statewalker/webrun-site-builder`](../webrun-site-builder) (or anywhere
else that produces a `SiteHandler = (Request) => Promise<Response>`).

```ts
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";

const handler = new SiteBuilder()
  .setEndpoint("/api/time", () => new Response(new Date().toISOString()))
  .setFiles("/", clientFiles)
  .build();

const site = await new HostedSiteBuilder()
  .setSiteKey("demo")
  .setHandler(handler)
  .build();

iframe.src = site.baseUrl;
```

The split is intentional: the same `SiteHandler` works in every host
(browser+SW via `HostedSiteBuilder`, `MessagePort` via
[`PortSiteBuilder`](../webrun-http-port), Node via a future `NodeSiteBuilder`,
…). Configuration lives in one place.

## Cross-application HTTP (no domains, no certificates)

Because the handler is just a function, you can point it at a remote peer over
any transport that produces a `MessagePort` (WebSocket, WebRTC, libp2p,
LiveKit, …). The browser-side host doesn't care:

```ts
import { fetchOverPort } from "@statewalker/webrun-http-port/fetch";

const port = await connectToPeer(); // any webrun-port-* adapter
const site = await new HostedSiteBuilder()
  .setHandler((request) => fetchOverPort(port, request))
  .build();

iframe.src = site.baseUrl;
// Every fetch inside the iframe is now proxied across the peer connection.
```

## API

```ts
class HostedSiteBuilder {
  constructor(options?: HostedSiteBuilderOptions);
  setSiteKey(key: string): this;
  setServiceWorkerUrl(url: string): this;
  setHandler(handler: SiteHandler): this;
  build(): Promise<HostedSite>;
}

interface HostedSite {
  readonly siteKey: string;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

interface HostedSiteBuilderOptions {
  adapterFactory?: AdapterFactory;
}
```

Plus a standalone utility for the "endpoint is a JS module dynamically
imported from the site itself" pattern:

```ts
export function newServerRunner(
  modulePath: string,
  getBaseUrl: () => string,
  env?: Record<string, unknown>,
): EndpointHandler;
```

Use it with `SiteBuilder.setEndpoint`:

```ts
let getBaseUrl = () => "";
const handler = new SiteBuilder()
  .setFiles("/server", serverFiles)
  .setEndpoint("/api", newServerRunner("/server/api/index.js", () => getBaseUrl()))
  .build();

const site = await new HostedSiteBuilder().setHandler(handler).build();
getBaseUrl = () => site.baseUrl;
```

## What `build()` does

1. Resolve `siteKey` (generated UUID if not set) and `swUrl` (`/sw-worker.js`
   if not set).
2. Construct and start the adapter (`SwHttpAdapter` by default — registers
   the ServiceWorker and awaits activation).
3. Register a fetch interceptor under `<origin>/<siteKey>/` that:
   - Strips the SW prefix from the incoming `Request.url`.
   - Dispatches to your handler.
4. Return a `HostedSite` with the resolved `baseUrl` and a `stop()` for
   teardown.

## See also

- [`@statewalker/webrun-site-builder`](../webrun-site-builder) — produces a
  `SiteHandler` from endpoints + files + auth + routing.
- [`@statewalker/webrun-http-port`](../webrun-http-port) — `PortSiteBuilder`
  sibling host, plus `fetchOverPort` / `serveFetchOverPort` for routing
  over `MessagePort`.
- [`apps/site-builder-demo`](../../apps/site-builder-demo) and
  [`apps/site-builder-tsx-spike`](../../apps/site-builder-tsx-spike) —
  runnable examples.

## Development

```bash
pnpm test        # vitest run
pnpm run build   # rolldown + tsc --emitDeclarationOnly
pnpm lint        # biome check src tests
```

## License

MIT
