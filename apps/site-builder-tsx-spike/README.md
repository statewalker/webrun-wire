# site-builder-tsx-spike

A spike on top of [`site-builder-demo`](../site-builder-demo) that
adds one thing: source-level transpilation of `.ts` and `.tsx` files
served from the in-memory site, so the browser's native module loader
can run them as-is.

## Main demonstration point

**`ServeFilesOptions.transform` is a per-mount Response filter, and a
single sucrase-backed instance applied to both the `/client` and
`/server` mounts is all you need to serve `.ts` / `.tsx` source
directly to the browser as `text/javascript` — including the
dynamic-imported server handler.**

The same filter handles three cases uniformly:

- `client/main.tsx` — typed + JSX (transforms: `typescript` + `jsx`)
- `client/format.ts` — typed helper imported by `main.tsx` via
  explicit `.ts` extension
- `server/api/index.ts` — typed `(Request, env) → Response` handler,
  loaded via `setServerRunner("/api", "/server/api/index.ts", { greeting, service })`
  and dynamic-imported through the same SW + transform pipeline. The
  third `setServerRunner` argument is the env bag the module receives
  alongside the URL params on every call.

No bundler, no service-side build step, no SW-internal wasm. sucrase
is pure JS, runs on the main thread; the SW just relays. Output is
cached by source SHA-256 so repeated fetches don't re-transpile.

## What's served

```
/client/index.html       static
/client/style.css        static
/client/format.ts        TS  → transpiled by transform
/client/main.tsx         TSX → transpiled by transform (typescript + jsx)
/server/api/index.ts     TS  → transpiled by transform
/api                     setServerRunner endpoint → dynamic-imports
                         /server/api/index.ts as a module
```

Wiring is in [`src/main.ts`](./src/main.ts); the transform is in
[`src/script-transform.ts`](./src/script-transform.ts).

## What it does not do

Everything that's Step 2+ of the in-browser build pipeline:

- No `external/<pkg>@<v>/...` virtual mount, no CDN fetching of bare
  specifiers.
- No `uri-graph` integration, no `ContentRouter`, no multi-FS layering.
- No `es-module-lexer`, no import rewriting, no source maps, no HMR.
- No persistent cache — only an in-memory `Map<sha256, code>`.

Step 1 spec:
[notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md](../../../../notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md).

## Run

```sh
pnpm --filter @statewalker/site-builder-tsx-spike dev
```

Open <http://localhost:5174>. Type in the Name field — every
keystroke fetches `/api`, runs the typed server handler, and renders
the formatted response.

## Verify in DevTools

In Network, the response `Content-Type` for `client/main.tsx`,
`client/format.ts`, and `server/api/index.ts` is `text/javascript`,
and their bodies are transpiled JS (no `interface`, no `: type`
annotations).

In Console, `[script-transform]` logs once per script fetch — useful
for catching a stale-SW scenario where the filter never runs.

## Stale ServiceWorker?

If the spike behaves as if old code is running, you have a stale SW
from a previous session. **DevTools → Application → Service Workers
→ Unregister**, then **Storage → Clear site data**, then hard reload.
Or just open the spike in a fresh Incognito/Private window.
