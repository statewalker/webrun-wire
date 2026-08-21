# @statewalker/webrun-rpc-http

HTTP-based service RPC. Expose plain object methods as a standard
`(Request) ⇒ Response` handler; call them from anywhere with `fetch`.

## Why it exists

The HTTP primitives in
[`@statewalker/webrun-http-streams`](../webrun-http-streams) let you write a
handler that answers `fetch()` — over the wire, in the same tab, inside a
ServiceWorker, across a MessagePort bridge. What they don't give you is a
layer above that: a way to take a plain service object and turn its methods
into addressable endpoints.

`webrun-rpc-http` is that layer. Deliberately small — two factory
functions plus a handful of types:

- `newRpcServer(services, {path?}) ⇒ (Request) ⇒ Response` — one handler
  that routes `GET /`, `GET /{service}`, and
  `GET|POST /{service}/{method}` into object method calls.
- `newRpcClient({baseUrl, fetch?})` — lazily fetches the service
  descriptor and returns typed proxies whose method calls round-trip
  through `fetch`.

Because the server is *just* a `(Request) ⇒ Response` handler and the
client is *just* `fetch`, the exact same RPC code runs over whatever
transport you wire it to:

| Transport | How |
| --- | --- |
| Real HTTP over the network | Default: `fetch = globalThis.fetch`. |
| An in-browser ServiceWorker | `@statewalker/webrun-http-browser` — the SW intercepts the standard `fetch` call with no special wiring. |
| In-process tests | Pass `fetch: (request) => handler(request)` — no network at all. |
| A MessagePort channel | `@statewalker/webrun-streams-port` for the `Duplex`, then `fetchOverDuplex` / `serveFetchOverDuplex` from `@statewalker/webrun-http-streams`. |
| A WebSocket | Same, with `@statewalker/webrun-streams-ws` supplying the `Duplex`. |
| Deno / Cloudflare Workers / Node's built-in HTTP | The handler is `(Request) ⇒ Response` — drop in as-is. |

## How to use

```sh
npm install @statewalker/webrun-rpc-http
```

### Exports

| Export | Purpose |
| --- | --- |
| `newRpcServer(services, opts?)` | Build a `(Request) ⇒ Response` handler from a map of service objects. Accepts `{ path }` to mount under a URL prefix. |
| `newRpcClient({baseUrl, fetch?})` | Build a lazy RPC client. Returns `{ loadService<T>(name) }`; the descriptor at `baseUrl/` is fetched once on first call and cached. |
| `RpcMethod` | `(params: Json, body?: Blob) ⇒ Promise<Blob \| Json>` — the shape every exposed method must satisfy. |
| `RpcClient` | Shape of the object returned from `newRpcClient`: `{ loadService<T>(name) }`. |
| `Json` / `JsonObject` | Recursive JSON types — everything that survives a `JSON` round-trip. |
| `getInstanceMethods(instance)` | Reflect callable properties of `instance` into a `Record<string, Function>`, walking the prototype chain up to (but not including) `Object.prototype`. Used internally by `newRpcServer`; exposed for callers that need it. |

## Examples

### Expose a service

```ts
import { newRpcServer } from "@statewalker/webrun-rpc-http";

class MathService {
  async add(params: { a: number; b: number }) {
    return params.a + params.b;
  }
  async bytes(params: { count: number }) {
    return new Blob([new Uint8Array(params.count).fill(0xff)]);
  }
}

const handler = newRpcServer({ math: new MathService() });

// Plug into anything that speaks Request ⇒ Response:
export default { fetch: handler };        // Deno / Bun / Cloudflare Workers
// or: Bun.serve({ fetch: handler, port: 8080 });
// or: http.createServer(/* adapt */)      // Node's built-in http
```

Out of the box the handler answers:

| Request | Response |
| --- | --- |
| `GET /` | `{ "math": ["add", "bytes"] }` — service descriptor. |
| `GET /math` | `["add", "bytes"]` — method list. |
| `POST /math/add` — multipart with `params` JSON | `{ "type": "json", "result": 5 }` |
| `GET /math/add?a=2&b=3` | `{ "type": "json", "result": "23" }` — URL params are parsed into `params`, but as **strings**, so `add` concatenates. POST JSON when the argument type matters. |
| `POST /math/bytes` — Blob result | `application/octet-stream` body. |

### Call a service

```ts
import { newRpcClient } from "@statewalker/webrun-rpc-http";

const client = newRpcClient({ baseUrl: "https://api.example.com/rpc" });
const math = await client.loadService<MathService>("math");

await math.add({ a: 2, b: 3 });             // 5
const blob = (await math.bytes({ count: 16 })) as Blob;
```

The descriptor at `baseUrl/` is fetched once, on the first `loadService`
call, and cached for every subsequent call on the same client instance.
Method proxies are lazy — they build one `POST` per invocation, no
persistent connection held open.

### Wire client directly to server (in-process)

Pass any `(Request) ⇒ Promise<Response>` as the `fetch` option. This is
how you run the client against an in-process server — unit tests,
webrun-http-browser SWs, a MessagePort bridge, a WebSocket bridge:

```ts
const handler = newRpcServer({ math: new MathService() });
const client = newRpcClient({
  baseUrl: "http://in-process",
  fetch: (request) => handler(request),
});
const math = await client.loadService<MathService>("math");
await math.add({ a: 1, b: 2 }); // 3 — no network.
```

### Mount in a browser ServiceWorker

Combine with `@statewalker/webrun-http-browser` to get an in-browser RPC
server that answers real `fetch()` calls:

```ts
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { newRpcServer } from "@statewalker/webrun-rpc-http";

const adapter = new SwHttpAdapter({
  key: "api",
  serviceWorkerUrl: new URL("./sw-worker.js", import.meta.url).toString(),
});
await adapter.start();

const { baseUrl } = await adapter.register(
  "api/",
  newRpcServer({ math: new MathService() }),
);

// Now any page script can do:
const client = newRpcClient({ baseUrl });
const math = await client.loadService<MathService>("math");
```

### Mount under a path prefix

```ts
const handler = newRpcServer(services, { path: "/api/v1" });

// GET  /api/v1/                   → descriptor
// POST /api/v1/math/add           → call
// GET  /api/v1/math/add/foo/bar   → call with params.$path === "foo/bar"
```

Requests outside the prefix get a 404 response with the same JSON-error
shape as any other error.

### Errors

Every error — method throws, unknown routes, descriptor failures —
returns a JSON object:

```json
{ "type": "error", "message": "…", "stack": "…", "…any custom fields": "…" }
```

| Cause | HTTP status | Body |
| --- | --- | --- |
| Method body throws | 200 | `{ "type": "error", … }` — the call reached the method. |
| Method doesn't exist | 500 | Same shape — routing failure. |
| Unknown path | 404 | Same shape. |
| `response.ok === false` with non-JSON body | — | Client throws a generic `RPC call failed: status text`. |

On the client, every serialized error is rehydrated into an `Error`
instance via
[`@statewalker/webrun-streams`](../webrun-streams)'s `deserializeError`
— preserving `message`, `stack`, and any custom fields the server
attached to a thrown `Error` subclass.

## Internals

### Descriptor format

`getInstanceMethods` walks each service's prototype chain and picks up
every function-valued property except `constructor`, stopping before
`Object.prototype`. It returns a `Record<string, Function>`; the wire
descriptor is built from its keys. That means:

- Plain object literals `{ foo() {…} }` expose `foo`.
- Class instances expose methods defined on any ancestor class up to
  `Object.prototype` (`toString`, `hasOwnProperty`, … are *not*
  exposed).
- Inherited methods work: `class Child extends Parent` instance exposes
  every method from both.

The descriptor shape is `Record<string, string[]>` — just names, no
signatures. Clients build proxy objects from the name list alone.

### Wire format — call encoding

| Method | Body |
| --- | --- |
| `POST /svc/method` | `multipart/form-data` with fields `params` (JSON-stringified) and optional `body` (`Blob`). |
| `GET /svc/method?k=v` | Query string parsed into JSON. Dot-separated keys nest: `?a.b=c&a.d=e` → `{ a: { b: "c", d: "e" } }`. |

All query-string values stay as **strings** (URLSearchParams' contract).
If your method expects numbers, POST JSON instead of GET'ing a querystring.

### Wire format — sub-path injection

The URL tail after `/svc/method/` is injected into `params.$path`:

- `GET /svc/method/foo/bar` → `params.$path === "foo/bar"`.
- Useful for REST-style handlers (`GET /files/read/some/deep/path`).
- `$path` is always present (empty string when there is no tail).

### Wire format — response encoding

| Method returns | Status | Body |
| --- | --- | --- |
| `Json` | 200 `application/json` | `{ "type": "json", "result": … }` |
| `Blob` | 200 `application/octet-stream` | Raw bytes. |
| thrown `Error` | 200 `application/json` | `{ "type": "error", message, stack, …}` |
| routing failure | 500 or 404 | Same `type: "error"` shape. |

### Design notes

- **Factory, not class.** Matches the rest of the workspace
  (`newHttpClientStub`, `newHttpCodec`, `newBasicAuth`, …). No public
  class surface to subclass; behaviour is configured via the options
  object.
- **Cached descriptor, lazy load.** The first `loadService` call fires
  the `GET baseUrl/` request; every subsequent call returns the same
  proxy object. Restart the client (`newRpcClient(...)`) to refresh.
- **Errors go through `@statewalker/webrun-streams`.** One
  (de)serialization format shared across the webrun stack; no duplicate
  `errors.ts` file.
- **No client-side type generation.** The client returns
  `Record<string, RpcMethod>` by default; pass a concrete interface with
  `loadService<MyService>("name")` to recover typing. TypeScript
  structural compatibility does the rest.
- **The `$path` trick is optional.** If your method doesn't read
  `params.$path`, nothing changes. It's there for REST-style handlers
  that care about the tail.

### Constraints

- **One prototype chain.** `getInstanceMethods` stops before
  `Object.prototype`. Methods defined on `Object.prototype` are
  deliberately excluded — you can't accidentally expose `toString`.
- **No streaming.** A method returns once, with one `Json` or `Blob`.
  Use `@statewalker/webrun-http-streams` directly (`fetchOverDuplex` /
  `serveFetchOverDuplex`) for streaming responses.
- **Path prefix without trailing slash.** `path: "/api"` is right;
  `path: "/api/"` is normalized (trailing slash stripped).
- **URLSearchParams are strings.** `?a=1` → `params.a === "1"`. POST
  JSON-encoded params whenever the argument type matters.
- **No content negotiation.** JSON in, JSON or binary out — nothing more.
- **`baseUrl` without trailing slash.** The client concatenates
  `${baseUrl}/${service}/${method}`; trailing slash would double.

### Dependencies

Runtime:

- `@statewalker/webrun-streams` — error (de)serialization
  (`serializeError` / `deserializeError`). Workspace-local.

Otherwise zero runtime deps: platform builtins only (`Request`,
`Response`, `FormData`, `Blob`, `URL`, `URLSearchParams`).

Dev: TypeScript, vitest, rolldown, rimraf, `@types/node` (catalog
versions from the monorepo root).

## Scripts

```sh
pnpm test        # vitest run
pnpm run build   # rolldown + tsc --emitDeclarationOnly
pnpm lint        # biome check src tests
```

## License

MIT © statewalker
