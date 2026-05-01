# site-builder-demo

A Vite + TypeScript app that mounts a complete in-browser HTTP site
(static client, dynamic `/api`, server-side module, iframe preview)
from a single
[`HostedSiteBuilder`](../../packages/webrun-site-host) call. No
backend, no disk, nothing leaves the tab.

## Main demonstration point

**The whole site — client assets, server module, and the `/api`
endpoint that wires them together — is one fluent `.build()` call,
and the server handler is a JS module served by the same site and
dynamic-imported per request.**

That second part is the unusual one: the API endpoint isn't a
function passed to the builder. It's a URL —
`/server/api/index.js` — registered via
`setServerRunner("/api", "/server/api/index.js")`. At request time
the builder dynamic-imports that URL through the same ServiceWorker
that's serving everything else, evaluates the JS as a module, and
delegates to its `default` export. Edit the module body and the next
request picks it up.

The complete wiring is ~40 lines of TypeScript in
[`src/main.ts`](./src/main.ts).

## What's served

```
/demo/client/index.html       static  → MemFilesApi (clientResources)
/demo/client/style.css        static
/demo/client/main.js          static
/demo/server/api/index.js     static  → MemFilesApi (serverResources)
/demo/api?name=…              endpoint → setServerRunner dynamic-imports
                                         /demo/server/api/index.js
```

`clientResources` and `serverResources` are plain `Record<string,
string>` maps in [`src/site.ts`](./src/site.ts), auto-wrapped by the
builder into `MemFilesApi` instances.

## How a request flows

```
iframe (/demo/client/index.html)
  └─ fetch("../api?name=Ada")
       └─ ServiceWorker intercepts
            └─ outer page handler (SiteBuilder routes match /api)
                 └─ dynamic-import("/demo/server/api/index.js")
                      └─ same SW serves the .js text → browser evals
                           └─ module.default(request) → JSON Response
```

## Strict path matching

The site only serves exact paths. The iframe must use the full
filename — `${baseUrl}client/index.html`, not `${baseUrl}client/`.
There is no implicit `index.html` resolution unless `directoryIndex`
is configured.

| URL | Result |
| --- | --- |
| `/demo/client/index.html` | 200 |
| `/demo/client/` | 404 |
| `/demo/client/nope.html` | 404 |
| `/demo/api?name=Ada` | 200 (JSON) |

## Run

```sh
pnpm install         # once, from the workspace root
pnpm run dev         # vite dev server on :5173
pnpm run typecheck   # tsc --noEmit
pnpm run build       # vite build → dist/
pnpm run preview     # vite preview on :5173
```

Open <http://localhost:5173/>. The right panel logs the mounted site
URL; the iframe shows the hosted client. Typing into the input fires
`fetch("../api?name=…")` and renders the server module's JSON reply.

## Verify in DevTools

- **Network → iframe fetches**: every request shows
  `from ServiceWorker`. No traffic hits Vite for `/demo/*`.
- **Application → Service Workers**: `/sw-worker.js` is activated and
  controls the page.
- **Network**: `client/main.js` and `server/api/index.js` come back
  with the same `200 from ServiceWorker`; the builder rewrites their
  URLs to live under the site key.

## File layout

```
apps/site-builder-demo/
├── index.html              — outer page (Vite entry)
├── src/
│   ├── main.ts             — HostedSiteBuilder call + iframe wiring
│   └── site.ts             — clientResources + serverResources
├── vite.config.js          — copies sw-worker.js to /sw-worker.js
├── tsconfig.json
└── package.json
```

The only static asset Vite copies into dev/build output is the
pre-built ServiceWorker runtime
(`@statewalker/webrun-http-browser/dist/sw-worker.js`), placed at
`/sw-worker.js`. Its default scope is `/`, which puts the outer page
under SW control — required for `SwHttpAdapter.start()` to resolve.

## Things to try

- Swap `MemFilesApi` for `BrowserFilesApi` backed by
  `window.showDirectoryPicker()` — hosted site rooted in a real
  folder, no other code change.
- Edit `serverResources["/api/index.js"]`: streaming, sessions,
  WebSocket fan-out, whatever — the page infrastructure doesn't move.
- Add a second `HostedSiteBuilder` with a different `siteKey`. Both
  share the SW; their URL spaces don't collide.
- Add `.setAuth("/admin/*", newBasicAuth({...}))` and a handler at
  `/admin/`.

## Related demos

| Demo | Pattern |
| --- | --- |
| **This app** | Same-origin SW + `HostedSiteBuilder` + dynamic-imported server module |
| [`site-builder-tsx-spike`](../site-builder-tsx-spike) | Same as this, plus per-mount `transform` filter to serve `.ts/.tsx` on the fly |
| [`packages/webrun-http-browser/demo/demo-1.html`](../../packages/webrun-http-browser/demo/demo-1.html) | Relay SW + Hono router as the handler |
| [`packages/webrun-http-browser/demo/demo-2.html`](../../packages/webrun-http-browser/demo/demo-2.html) | Relay SW + File System Access API folder |
| [`packages/webrun-http-browser/public/index.html`](../../packages/webrun-http-browser/public/index.html) | Bare `SwHttpAdapter`, no `SiteBuilder` |

This is the highest-level wrapping (`HostedSiteBuilder`) plus the
dynamic-import server-module pattern. The other demos use manual
handler functions.
