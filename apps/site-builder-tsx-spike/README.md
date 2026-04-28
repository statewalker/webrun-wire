# site-builder-tsx-spike

Proof-of-life for **Step 1** of the in-browser build pipeline described in
[notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md](../../../../notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md).

## What it proves

- `ServeFilesOptions.transform` is a per-mount Response filter that runs
  after `newServeFiles` produces its response.
- A trivial sucrase-backed filter is enough to serve `.ts`/`.tsx` source as
  `Content-Type: text/javascript` so the browser's native module loader
  executes it.
- No bundler, no service-side build step, no service-worker-internal wasm —
  sucrase is pure JS, lives on the main thread, and the SW just relays.

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
the iframe shows the served client. Inspect the network tab — the response
for `/client/main.tsx` is `Content-Type: text/javascript` with transpiled
JS in the body.
