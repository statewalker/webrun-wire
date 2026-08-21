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

The split is intentional: the same `SiteHandler` works in every host —
browser + SW via `HostedSiteBuilder`, any `webrun-streams-*` transport via
[`DuplexSiteBuilder`](../webrun-http-streams), and Node / Deno / Bun /
Cloudflare Workers directly, since a `SiteHandler` already *is* their handler
shape. Configuration lives in one place.

## Cross-application HTTP (no domains, no certificates)

Because the handler is just a function, you can point it at a remote peer over
any `webrun-streams-*` transport (WebSocket, WebRTC, libp2p, LiveKit,
MessagePort, …). The browser-side host doesn't care:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-ws";

const { call } = await connect({ url: "wss://peer.example" }); // any adapter
const site = await new HostedSiteBuilder()
  .setHandler((request) => fetchOverDuplex(call, request))
  .build();

iframe.src = site.baseUrl;
// Every fetch inside the iframe is now proxied across the peer connection.
```

`apps/livekit-demo/client-page/main.ts` and `apps/p2p-demo/client-page/main.ts`
are both this pattern against a real transport.

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

`build()` throws if `setHandler` was not called. `siteKey` defaults to a
generated UUID and `serviceWorkerUrl` to `/sw-worker.js`. `adapterFactory` is
the seam the tests use to inject a fake instead of a real ServiceWorker; it
also takes `SiteAdapter`, `SiteAdapterRegistration` and `AdapterFactory`, all
exported.

Also exported, for callers that accept "a `FilesApi` or a plain path → content
map" in their own APIs:

```ts
type FilesSource = FilesApi | Record<string, string | Uint8Array>;
function resolveFilesSource(source: FilesSource): Promise<FilesApi>;
```

`HostedSiteBuilder` itself never calls it — it hosts a `SiteHandler` and owns
no file configuration.

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
- [`@statewalker/webrun-http-streams`](../webrun-http-streams) —
  `DuplexSiteBuilder`, the sibling host for any `webrun-streams-*` transport,
  plus `fetchOverDuplex` / `serveFetchOverDuplex`.
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
