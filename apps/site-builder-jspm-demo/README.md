# @statewalker/site-builder-jspm-demo

## What it is

A demo built on top of [`site-builder-tsx-spike`](../site-builder-tsx-spike)
that lets user-authored `.ts` / `.tsx` source — for both the in-browser
client AND the in-browser "server" — use ordinary bare specifiers
(`import React from "react"`, `import { z } from "zod"`) and have them
resolved entirely in the browser through a `@jspm/generator`-driven
pipeline. Third-party bytes are mirrored onto a same-origin
**`/<siteKey>/external/<pkg>@<v>/<file>`** path, and every import in every
served file — first-party or CDN-fetched — is rewritten in place to a
**relative URL** to that path, so the resulting bundle is
mount-prefix-agnostic and drop-deployable.

## Why it exists

The spike (`site-builder-tsx-spike`) proved that `.ts` / `.tsx` source can
be transpiled on the fly by a per-mount `ServeFilesOptions.transform`
filter, and run by the browser's native module loader without any bundler.
What it intentionally did not solve is **bare specifiers**: every
`import` statement in user source had to point at a relative file path.
Anything from npm — React, Zod, Lodash — was out of reach. That's Step 2
of the in-browser build pipeline described in
[notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md](../../../../notes/2026-04/2026-04-28/06.in-browser-build-pipeline-architecture.md).

This demo is the first proof of Step 2. It introduces:

- A **resolver** built around `@jspm/generator`, run in the host page main
  thread at site-build time, which consumes a source `package.json` and
  every bare specifier discovered by an `es-module-lexer` pass.
- A same-origin **`/external/*` mount** that the SW serves from a
  MemFilesApi-backed cache; the cache is populated eagerly by recursively
  fetching every dependency in the resolver's manifest from
  `ga.jspm.io`.
- A **uniform rewrite step** applied to first-party source AND CDN content:
  every import specifier (bare or absolute `ga.jspm.io` URL) is replaced
  with a **relative** path into `/external/`. Rewritten output is what the
  SW serves; raw source stays untouched as input.
- A sidecar **resolution manifest** (`resolution-manifest.json`),
  inspectable and consumable by a future bundling step, but **not**
  load-bearing at runtime — the rewritten source already has every URL
  baked in.

`es-module-shims` is intentionally *not* used: the rewriting model removes
its only job (resolving bare specifiers at runtime). Native browser
module loading handles absolute and relative URLs without a shim. See
[CONTEXT.md](../../CONTEXT.md) § "es-module-shims and es-module-lexer".

## How to use

The demo's `main.ts` wires four things and hands the result to
`HostedSiteBuilder`:

1. A `MemFilesApi` for `/client` holding `index.html`, `style.css`,
   `main.tsx`, plus a shared `package.json`.
2. A `MemFilesApi` for `/server` holding `api/index.ts`.
3. A `JspmResolver` (single-file module in this app), constructed once
   with the shared `package.json`'s `dependencies`. It exposes one method:
   `resolveAndPrefetch(sourceFs[]) → { rewrittenSourceFs, externalFs, manifest }`.
4. The standard `SiteBuilder` + `HostedSiteBuilder` chain from the spike,
   pointed at the rewritten outputs instead of the raw sources.

```ts
const sharedPkg = JSON.parse(packageJsonSource);
const clientFiles = recordToFilesApi(clientResources);
const serverFiles = recordToFilesApi(serverResources);

const { client, server, external, manifest } = await new JspmResolver()
  .setPackageJson(sharedPkg)
  .setSiteKey("jspm")
  .setTransform(newScriptTransform())  // sucrase from the spike
  .addSource("/client", clientFiles)
  .addSource("/server", serverFiles)
  .resolveAndPrefetch();

const handler = new SiteBuilder()
  .setFiles("/client", client)
  .setFiles("/server", server)
  .setFiles("/external", external)
  .setEndpoint(
    "/api",
    newServerRunner("/server/api/index.ts", () => baseUrl, {
      service: "site-builder-jspm-demo",
    }),
  )
  .build();

// `manifest` is a JSON import-map artifact (resolution manifest);
// emit it as a sidecar file or expose it in the UI for inspection.
```

## Examples

### Client uses React (automatic JSX runtime)

```tsx
// /client/main.tsx — author exactly as in a normal Vite/Next React app
import { createRoot } from "react-dom/client";

function App() {
  return <h1>Hello from in-browser React</h1>;
}

const el = document.querySelector("#root");
if (!el) throw new Error("no root");
createRoot(el).render(<App />);
```

Post-rewrite, the served `/client/main.js` contains (paths shortened):

```js
import { jsx as _jsx } from "../external/react@18.3.1/jsx-runtime.js";
import { createRoot } from "../external/react-dom@18.3.1/client.js";
function App() { return _jsx("h1", { children: "Hello from in-browser React" }); }
const el = document.querySelector("#root");
if (!el) throw new Error("no root");
createRoot(el).render(_jsx(App, {}));
```

### Server uses zod

```ts
// /server/api/index.ts
import { z } from "zod";

const schema = z.object({ name: z.string().min(1) });

export default async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = schema.safeParse({ name: url.searchParams.get("name") ?? "" });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  return Response.json({ greeting: `Hello, ${parsed.data.name}!` });
}
```

Post-rewrite, `/server/api/index.js` becomes:

```js
import { z } from "../../external/zod@3.23.8/index.js";
// (body unchanged except for the rewritten import)
```

The host page realm dynamic-imports this rewritten module via
`setServerRunner` — exactly as in the spike — and the import resolves
without needing a runtime import map.

### `/external/*` contents (illustrative)

```
/jspm/external/react@18.3.1/index.js
/jspm/external/react@18.3.1/jsx-runtime.js
/jspm/external/react-dom@18.3.1/client.js
/jspm/external/scheduler@0.23.2/index.js
/jspm/external/zod@3.23.8/index.js
```

Every file under `/external/` was fetched from `ga.jspm.io/npm:...`, lex-
rewritten so all internal imports are relative paths to neighboring
`/external/` entries, and cached in a MemFilesApi.

### Resolution manifest (sidecar artifact)

```json
{
  "imports": {
    "react": "./external/react@18.3.1/index.js",
    "react/jsx-runtime": "./external/react@18.3.1/jsx-runtime.js",
    "react-dom/client": "./external/react-dom@18.3.1/client.js",
    "zod": "./external/zod@3.23.8/index.js"
  }
}
```

Not consumed by the browser at runtime; emitted for inspection and to
seed a future static-bundling step.

### Failure paths

```ts
// 1. Bare specifier discovered in source but absent from package.json.
//    JspmResolver throws synchronously during resolveAndPrefetch() with
//    the offending specifier and the path of the file that introduced it.

// 2. ga.jspm.io unreachable during prefetch.
//    resolveAndPrefetch() rejects with a network error wrapped with the
//    failing pkg@v/file. The demo's main.ts displays it in the on-page
//    log; the iframe is not mounted.

// 3. A CDN response is non-ESM (e.g. an HTML 404 body).
//    Lex pass throws; the resolver wraps with context (URL, status) and
//    rejects. No partial /external/ cache is exposed.
```

## Internals

The pipeline lives in four single-file modules under `src/`:

- [`script-transform.ts`](./src/script-transform.ts) — sucrase wrapper.
  `transformSource(path, source)` runs the right combination of
  `["typescript"]` (for `.ts`) or `["typescript", "jsx"]` (for `.tsx`) with
  `jsxRuntime: "automatic"`, `jsxImportSource: "react"`. Exports also a
  `newScriptTransform()` factory that returns a
  `ServeFilesOptions.transform` filter for parity with the spike, though
  the demo's main pipeline transpiles up front rather than at fetch time.
- [`lex-rewrite.ts`](./src/lex-rewrite.ts) — three pure functions over
  `es-module-lexer`: `discoverSpecifiers(code)` returns the deduplicated
  list of static-and-string-literal-dynamic import specifiers;
  `rewriteImports(code, mapSpecifier)` walks imports in reverse order so
  positional rewrites don't shift later ranges; `relativePath(from, to)`
  is the path-arithmetic helper that produces minimal `./` / `../`-
  prefixed paths. The module re-exports the lexer's `init` promise; the
  caller awaits it once before invoking the other functions.
- [`jspm-resolver.ts`](./src/jspm-resolver.ts) — the orchestrator.
  `JspmResolver` is a builder (`setSiteKey`, `setPackageJson`,
  `addSource`) terminated by one async method
  `resolveAndPrefetch(): Promise<ResolveOutput>`. It (1) transpiles every
  source script via `transformSource`, (2) collects bare specifiers via
  `discoverSpecifiers`, (3) validates each against the source
  `package.json`, (4) installs each `(package, subpath)` pair into a
  `@jspm/generator` instance, (5) walks the generator's `getMap()` URLs
  in a fixed-point prefetch loop with recursive `rewriteImports` against
  CDN responses, (6) rewrites each first-party file with the same lex
  pass, and (7) emits the resolution manifest.
- [`main.ts`](./src/main.ts) — the demo wiring. Reads
  `clientResources`/`serverResources`/`sharedPackageJson` from
  [`site.ts`](./src/site.ts), runs `JspmResolver.resolveAndPrefetch()`,
  hands the result to a standard `SiteBuilder` + `HostedSiteBuilder`.
  Logs progress and surfaces the manifest into the host page.

The host page realm dynamic-imports the rewritten server module via
`newServerRunner` from `@statewalker/webrun-site-host` — unchanged from
the spike. No import map is injected anywhere; the rewritten bytes carry
only absolute relative URLs.

### Constraints

- **Eager-only prefetch.** `resolveAndPrefetch()` walks the full
  transitive dep graph before returning. No incremental rebuild; no live
  HMR. Source edits require a full page reload.
- **MemFilesApi cache only.** The `/external/*` cache is session-scoped.
  No IndexedDB or CacheStorage persistence in v1.
- **Single shared `package.json`** for client and server. A multi-FS,
  multi-`package.json` story is out of scope.
- **Host page realm runs the server module.** Acceptable because the
  rewritten server bytes carry no bare specifiers — nothing pollutes the
  host page's loader.
- **`ga.jspm.io` is the only backing CDN.** The `CdnProvider` abstraction
  discussed during the grill is not implemented; lifting to a pluggable
  interface is a future change.
- **Fail-loud at site build.** Any prefetch failure rejects
  `resolveAndPrefetch()` atomically; no partial `external` FilesApi is
  returned to the caller.

### Dependencies

Runtime:

- `@jspm/generator` (catalog) — resolution oracle; runs in the host page
  main thread, calls `fetch` against `ga.jspm.io` via the page's network
  stack.
- `es-module-lexer` (catalog) — wasm-backed JS lexer used by the
  discover-and-rewrite pass.
- `sucrase` (catalog) — TS/TSX → JS, automatic JSX runtime.
- `@statewalker/webrun-files-mem` (catalog) — `MemFilesApi` for both
  user-authored source records and the populated `/external/*` cache.
- `@statewalker/webrun-http-browser` (workspace) — ServiceWorker runtime
  copied as `sw-worker.js` into the dev/prod bundle.
- `@statewalker/webrun-site-builder` (workspace) — `SiteBuilder`.
- `@statewalker/webrun-site-host` (workspace) — `HostedSiteBuilder`,
  `newServerRunner`.

Dev:

- `vite` (catalog), `typescript` (catalog), `vitest` (catalog) — same as
  the spike.

## License

MIT © statewalker
