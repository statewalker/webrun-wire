# @statewalker/webrun-rpc-http

## What it is

HTTP-based service RPC. `newRpcServer` turns a map of plain service objects
into one standard `(Request) => Promise<Response>` handler, with an endpoint
per method. `newRpcClient` reads the server's service descriptor and returns
proxy objects whose method calls go out through `fetch`.

## Why it exists

A `(Request) => Response` handler can be reached in many ways: over the
network, through a ServiceWorker (`@statewalker/webrun-http-browser`), over a
`Duplex` (`@statewalker/webrun-http-streams`), or by calling it directly. What
a handler does not give you is a way to expose an object's methods as
addressable endpoints and call them back as methods. This package is that
layer, and because the server is just a handler and the client just a `fetch`,
the same RPC code runs over any of those transports:

| Transport | How |
| --- | --- |
| Real HTTP | Default `fetch` is `globalThis.fetch`; serve the handler from Deno, Bun, Cloudflare Workers, or any server that takes a `Request`. |
| A ServiceWorker | Register the handler with `@statewalker/webrun-http-browser`; the worker intercepts ordinary `fetch` calls. |
| In process | `fetch: (request) => handler(request)`; no network. |
| A `Duplex` (`MessagePort`, WebSocket, WebRTC…) | `serveFetchOverDuplex(handler)` on one side, `fetch: (r) => fetchOverDuplex(call, r)` on the other, both from `@statewalker/webrun-http-streams`. |

## How to use

```sh
pnpm add @statewalker/webrun-rpc-http
```

- **Peer dependencies:** none.
- **Runtime dependency:** `@statewalker/webrun-streams`, for error
  serialisation.
- **Entry point:** one, `.`. ESM only: `dist/index.js` with `dist/index.d.ts`.
  The `source` export condition points at `src/index.ts`.
- **Environment:** anything with `Request`, `Response`, `FormData`, `Blob` and
  `URL`: browsers, workers, service workers, Node, Deno, Bun.

| Export | Purpose |
| --- | --- |
| `newRpcServer(services, { path? })` | Build a `(Request) => Promise<Response>` handler from `Record<string, object>`. |
| `NewRpcServerOptions` | `{ path?: string }`: URL prefix to mount under; a trailing slash is stripped; empty (default) mounts at the root. |
| `newRpcClient({ baseUrl, fetch? })` | Build a client: `{ loadService<T>(name) }`. |
| `NewRpcClientOptions` | `{ baseUrl: string; fetch?: (request: Request) => Promise<Response> }`. `baseUrl` has no trailing slash. |
| `RpcClient` | The client's type. |
| `RpcMethod` | `(params: Json, body?: Blob) => Promise<Blob \| Json>`, the shape of every exposed method. |
| `Json`, `JsonObject` | JSON value types. |
| `getInstanceMethods(instance)` | Every function-valued property of `instance` and its prototype chain, up to but not including `Object.prototype`, minus `constructor`. Used by `newRpcServer`. |

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

export default { fetch: handler }; // Deno / Bun / Cloudflare Workers
```

| Request | Response |
| --- | --- |
| `GET /` | `{ "math": ["add", "bytes"] }`, the service descriptor |
| `GET /math` | `["add", "bytes"]` (an unknown service gives `[]`) |
| `POST /math/add`, multipart with a `params` JSON field | `{ "type": "json", "result": 5 }` |
| `GET /math/add?a=2&b=3` | `{ "type": "json", "result": "23" }`: query values are strings, so `add` concatenates |
| `POST /math/bytes` | `application/octet-stream` body |

### Call a service

```ts
import { newRpcClient } from "@statewalker/webrun-rpc-http";

const client = newRpcClient({ baseUrl: "https://api.example.com/rpc" });
const math = await client.loadService<MathService>("math");

await math.add({ a: 2, b: 3 }); // 5
const blob = (await math.bytes({ count: 16 })) as Blob;
```

The descriptor at `GET {baseUrl}` is fetched once, on the first `loadService`
call, and cached for the client's lifetime; create a new client to refresh it.
Every method call is one `POST` with no connection held open.
`loadService` rejects with `Service <name> not found` for a name the descriptor
does not list, and with `Failed to load services descriptor: <status> <statusText>`
when the descriptor request fails.

### Wire client to server in process

```ts
const handler = newRpcServer({ math: new MathService() });
const client = newRpcClient({
  baseUrl: "http://in-process",
  fetch: (request) => handler(request),
});
const math = await client.loadService<MathService>("math");
await math.add({ a: 1, b: 2 }); // 3, no network
```

### Serve from a browser ServiceWorker

The server must be mounted at the path the handler is registered under, and the
client's `baseUrl` must not end with `/`:

```ts
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { newRpcClient, newRpcServer } from "@statewalker/webrun-rpc-http";

const adapter = new SwHttpAdapter({
  key: "api",
  serviceWorkerUrl: new URL("./sw-worker.js", import.meta.url).toString(),
});
await adapter.start();

let rpc: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
const { baseUrl } = await adapter.register("api/rpc/", (request) => rpc(request));
rpc = newRpcServer({ math: new MathService() }, { path: new URL(baseUrl).pathname });

const client = newRpcClient({ baseUrl: baseUrl.replace(/\/$/, "") });
const math = await client.loadService<MathService>("math");
```

### Mount under a path prefix

```ts
const handler = newRpcServer(services, { path: "/api/v1" });

// GET  /api/v1/                   -> descriptor
// POST /api/v1/math/add           -> call
// GET  /api/v1/files/read/foo/bar -> call with params.$path === "foo/bar"
```

## Internals

### Wire format

```
client                                             server
math.add({a:2,b:3}) ──POST {baseUrl}/math/add──►  newRpcServer
                       multipart/form-data           │ params = JSON.parse(form.params)
                         params = '{"a":2,"b":3}'    │ params.$path = tail after /math/add/
                         body   = Blob (optional)    ▼
                    ◄── 200 application/json ──  { "type": "json", "result": 5 }
                    ◄── 200 octet-stream ──────  raw bytes, when the method returns a Blob
                    ◄── 200 application/json ──  { "type": "error", message, stack, ... }
```

Call encoding:

| Request | Arguments |
| --- | --- |
| `POST /svc/method`, `multipart/form-data` | `params` field (JSON) and optional `body` field (`Blob`). |
| `POST /svc/method`, any other content type | `params` is `{}`; the raw body becomes the `body` Blob. |
| `GET /svc/method?k=v` | Query string as `params`. Dot-separated keys nest: `?a.b=c&a.d=e` gives `{ a: { b: "c", d: "e" } }`. Values stay strings; repeated keys overwrite. |

The URL tail after `/svc/method/` is set as `params.$path` (an empty string when
there is none), so a method can serve REST-style paths such as
`GET /files/read/some/deep/path`. It is set only when `params` is an object.

The descriptor is `Record<string, string[]>`: names only, no signatures. The
client builds its proxies from the names, and `loadService<T>` restores typing
through a type argument; there is no code generation.

### Errors come back as JSON

Every error is a JSON object `{ "type": "error", "message", "stack", ...custom fields }`:

| Cause | HTTP status |
| --- | --- |
| The method throws | `200`; the call reached the method |
| Unknown method: `Method <m> not found in service <s>` | `500` |
| Path outside the prefix, or a method other than `GET`/`POST`: `Not found` | `404` |
| Non-JSON error response | client throws `RPC call failed: <status> <statusText>` |

The client rehydrates `type: "error"` bodies with `deserializeError` from
`@statewalker/webrun-streams`, so `message`, `stack` and custom fields of a
thrown `Error` subclass survive; the class does not. Error bodies include the
server-side `stack`, so do not expose a handler to callers who should not see
it.

### Constraints

- **Methods return once.** A method returns one `Json` value or one `Blob`; no
  streaming. For streaming responses use `fetchOverDuplex` /
  `serveFetchOverDuplex` from `@statewalker/webrun-http-streams` directly.
- **Only the prototype chain below `Object.prototype` is exposed.**
  `toString`, `hasOwnProperty` and the like are never endpoints. Methods of
  every ancestor class are.
- **`baseUrl` takes no trailing slash.** The client builds
  `${baseUrl}/${service}/${method}`; a trailing slash doubles it and the call
  fails with `Not found`.
- **The prefix matches whole path segments.** With `path: "/api/v1"`, the
  handler serves `/api/v1` and everything under `/api/v1/`; `/api/v1x/math`
  is outside the prefix and gets `404 Not found`.
- **No content negotiation.** JSON or multipart in, JSON or binary out.

### Design notes

- **Factory functions, not classes.** Behaviour is configured through options;
  there is no class surface to subclass.
- **Errors use `@statewalker/webrun-streams`.** One serialisation format shared
  with the rest of the webrun packages.

### Dependencies

One runtime dependency, `@statewalker/webrun-streams`, for `serializeError` /
`deserializeError`. Everything else is platform API (`Request`, `Response`,
`FormData`, `Blob`, `URL`, `URLSearchParams`).

### Scripts

```sh
pnpm test             # vitest run
pnpm run build        # rolldown + tsc --emitDeclarationOnly
pnpm run lint         # biome check src tests
```

## License

MIT
