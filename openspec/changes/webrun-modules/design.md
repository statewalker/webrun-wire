# Design: webrun-modules

Design record for the formalized contract. Source of truth for rationale:
`notes/2026/2026-07/2026-07-23/grill-module-webrun-modules.md`. This documents
decisions already realized in `packages/webrun-modules`.

## Locked constraints (pre-grill)

- **No runtime CDN.** The server MAY fetch from NPM/CDN once at resolve-time; the
  served result is self-contained from the local `FilesApi` cache. This rejects
  the "proxy already-ESM from an upstream CDN" default and makes CJS→ESM a problem
  solved locally.
- **Any npm module**, **isomorphic** (browser ServiceWorker + Node, same code, no
  native binaries — WASM/pure-JS only), **input is a TS/JS entry script**.
  Bundling / local copy-out is the explicit next step, out of scope here.

## Key decisions

- **One Seam-2 engine.** The per-file pipeline (lex → transpile TS/JSX/CJS→ESM →
  rewrite specifiers to local URLs) is identical for authored `project` bytes and
  npm `Source` bytes — "authored" vs "dependency" is only *where the bytes came
  from*. So `webrun-modules` owns authored source **and** the dependency graph,
  superseding the earlier `webrun-app-runtime` sketch. Attaching to a
  `SiteHandler` is a documented wiring pattern over `server.fetch` + `basePath`,
  not a separate package.

- **Version resolution — eager whole-graph dedupe.** During `prime`, pick one
  resolved version per package name where semver allows (npm-like hoisting);
  genuinely incompatible constraints (`react@17` + `react@18`) keep both pinned
  versions side by side (the `/{name}@{ver}/` path allows it). An optional
  `Lockfile` input pins versions for reproducible resolution.

- **Conditional resolution — condition precedence + explicit `target`.** An
  explicit `target` (default `"browser"`) selects the `exports`/`imports`
  condition set *and* is part of the cache key, so a browser build and a node
  build of the same file never collide. Under `browser`, `node:*` builtins (bare
  `path` and `node:path`) map to self-hosted browser polyfills served as local
  URLs; under `node`, `node:*` stays external.

- **Cache — injected `FilesApi`, never `node:fs`.** The cache backend
  (`NodeFilesApi` / browser-OPFS / `MemFilesApi`) is the only thing that changes
  between browser and Node. Pinned dep entries are immutable/append-only, keyed by
  `target + name@version + subpath + transformVersion`; raw untarred bytes and
  transformed ESM live under distinct keys on the same logical path. Mutable
  local/entry scripts key by content hash.

- **The resolution map IS the lockfile.** `prime` writes the version-dedupe map to
  the cache; reload loads it and does not re-solve unless the entry's declared
  dependency set or the input `lock` changes. Same artifact as the optional `lock`
  input — one lockfile, both `prime` output and reproducible input.

- **Serving surface — a standard Web Fetch handler.** The lazy server is a plain
  `(Request) => Promise<Response>` exposed as `server.fetch`; drop-in for
  `Deno.serve`, Hono `app.mount`, `export default { fetch }`, or a ServiceWorker
  `fetch` listener. Mountable under a `basePath` (default `/`). Internal
  module-to-module imports are baked as **relative** URLs so the transformed cache
  is prefix-portable — remounting under a new prefix needs no re-transform.

## Spike-gated risks (top risk first)

- **Sync-`require`-over-async-ESM (CJS interop).** The crux esm.sh/Vite avoid by
  bundling. Each CJS file is wrapped in an ESM shim exposing a synthetic
  `require`/`module`/`exports`, backed by the eagerly-primed registry so `require`
  resolves synchronously against an already-loaded graph; a CJS named-export lexer
  hoists named exports for interop, files stay 1:1. **Declared fallback:** if the
  interop long tail proves too costly, bundle-per-CJS-package (ESM stays 1:1; only
  CJS packages collapse). An unsupported dynamic/computed `require` surfaces a
  typed `ModuleTransformError`.

- **Constraint solver.** The `Source` already untars every `package.json`, so only
  the semver constraint solver is added on top; kept CDN-free (no resolve-time CDN
  provider, and never in the served output).
