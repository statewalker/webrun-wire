# site-builder-tsx-spike

Proof-of-life for **Step 1** of the in-browser build pipeline described in
[notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md](../../../../notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md).

## What it proves

- `ServeFilesOptions.transform` is a per-mount Response filter that runs
  after `newServeFiles` produces its response.
- A single sucrase-backed filter applied to **both** the `/client` and
  `/server` mounts is enough to:
  - serve client `.tsx` (typed + JSX) as `text/javascript` so the browser's
    native module loader runs it,
  - serve server `.ts` (typed `Request → Response` handler) the same way,
    so `setServerRunner("/api", "/server/api/index.ts")` can dynamic-import
    a TypeScript file directly.
- No bundler, no service-side build step, no service-worker-internal wasm —
  sucrase is pure JS, runs on the main thread, the SW just relays.

## What's served

```
/client/index.html       static
/client/style.css        static
/client/format.ts        TS  → transpiled by transform
/client/main.tsx         TSX → transpiled by transform (typescript + jsx)
/server/api/index.ts     TS  → transpiled by transform; loaded via setServerRunner
/api                     setServerRunner endpoint → dynamic-imports server/api/index.ts
```

The client form's input fires `fetch("../api?name=…")` on every keystroke;
the endpoint runs the typed server handler and returns JSON; the client
renders it through a typed `formatResponse` helper imported from a sibling
`.ts` file.

## What it doesn't do

Everything that's Step 2+:

- No `external/<pkg>@<v>/...` virtual mount, no CDN fetching of bare
  specifiers.
- No `uri-graph` integration, no `ContentRouter`, no multi-FS layering.
- No `es-module-lexer`, no import rewriting, no source maps, no HMR.
- No persistent or content-addressed caching — only an in-memory
  `Map<sha256(source), code>` keyed by content hash.

## Run

```bash
pnpm --filter @statewalker/site-builder-tsx-spike dev
```

Open <http://localhost:5174>. The right panel logs the mounted site URL;
the iframe shows the served client. Type in the Name field — every
keystroke fetches `/api`, runs the typed server handler, and renders the
formatted response.

In DevTools → Network, response `Content-Type` for `client/main.tsx`,
`client/format.ts`, and `server/api/index.ts` is `text/javascript`; their
bodies are transpiled JS (no `interface`, no `: type` annotations).

## Stale Service Worker?

If the spike behaves as if old code is running, you have a stale SW from a
previous session. **DevTools → Application → Service Workers → Unregister**,
then **Storage → Clear site data**, then hard reload — or just open the
spike in a fresh Incognito/Private window.
