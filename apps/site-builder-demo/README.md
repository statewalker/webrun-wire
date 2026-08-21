# site-builder-demo

A Vite + TypeScript app that mounts a complete in-browser HTTP site
(static client, dynamic `/api`, server-side module, iframe preview) from a
[`SiteBuilder`](../../packages/webrun-site-builder) definition hosted by
[`HostedSiteBuilder`](../../packages/webrun-site-host). No backend, no disk,
nothing leaves the tab.

## Main demonstration point

**The server handler is a JS module served by the same site and
dynamic-imported per request, called with `(request, env)`.**

The API endpoint isn't a function passed to the builder. It's a URL —
`/server/api/index.js` — reached through `newServerRunner`, the standalone
`EndpointHandler` factory from `@statewalker/webrun-site-host`:

```ts
new SiteBuilder()
  .setFiles("/client", clientFiles)
  .setFiles("/server", serverFiles)
  .setEndpoint(
    "/api",
    newServerRunner("/server/api/index.js", () => baseUrl, { greeting, service }),
  )
  .build();
```

At request time it dynamic-imports that URL through the same ServiceWorker
that's serving everything else, evaluates the JS as a module, and invokes its
`default` export with the `Request` plus an `env` bag. `env` carries the URL
`params` plus the values passed as the third `newServerRunner` argument —
that's how shared dependencies (DB connections, FilesApi instances, secrets)
reach a server module that lives in a string. Edit the module body and the
next request picks it up.

`newServerRunner` needs the live `baseUrl` to build absolute import URLs, and
`baseUrl` only exists after `HostedSiteBuilder.build()` — hence the mutable
ref closed over above and assigned afterwards. [`src/main.ts`](./src/main.ts)
spells this out.

The complete wiring is ~45 lines of TypeScript in
[`src/main.ts`](./src/main.ts).

## What's served

```
/demo/client/index.html       static  → MemFilesApi (clientResources)
/demo/client/style.css        static
/demo/client/main.js          static
/demo/server/api/index.js     static  → MemFilesApi (serverResources)
/demo/api?name=…              endpoint → newServerRunner dynamic-imports
                                         /demo/server/api/index.js
```

`clientResources` and `serverResources` are plain `Record<string,
string>` maps in [`src/site.ts`](./src/site.ts); `src/main.ts` writes each
into a `MemFilesApi` before handing it to `SiteBuilder.setFiles`.

## How a request flows

```
iframe (/demo/client/index.html)
  └─ fetch("../api?name=Ada")
       └─ ServiceWorker intercepts
            └─ outer page handler (SiteBuilder routes match /api)
                 └─ newServerRunner dynamic-imports "/demo/server/api/index.js"
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
│   ├── main.ts             — SiteBuilder + HostedSiteBuilder calls + iframe wiring
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
| **This app** | Same-origin SW + `SiteBuilder` + `HostedSiteBuilder` + dynamic-imported server module |
| [`site-builder-tsx-spike`](../site-builder-tsx-spike) | Same as this, plus per-mount `transform` filter to serve `.ts/.tsx` on the fly |
| [`packages/webrun-http-browser/demo/demo-1.html`](../../packages/webrun-http-browser/demo/demo-1.html) | Relay SW + Hono router as the handler |
| [`packages/webrun-http-browser/demo/demo-2.html`](../../packages/webrun-http-browser/demo/demo-2.html) | Relay SW + File System Access API folder |
| [`packages/webrun-http-browser/public/index.html`](../../packages/webrun-http-browser/public/index.html) | Bare `SwHttpAdapter`, no `SiteBuilder` |

This is the highest-level wrapping (`SiteBuilder` + `HostedSiteBuilder`) plus
the dynamic-import server-module pattern. The other demos use manual handler
functions.
