# Change: webrun-modules

## Why

Running authored TS/JS apps and the arbitrary npm modules they import in a
browser (or Node) normally means either a build step or a **runtime CDN
dependency** (esm.sh/jsDelivr) — the running app fetches modules from a third
party. That is unacceptable for offline-capable, self-contained apps and for the
isomorphic-eve "Compilation" seam (Seam 2), which must run the *same* code in a
ServiceWorker and in Node.

The `webrun-modules` engine already exists in this package and drives the
`notes-demo`. This change **formalizes its contract** — the grilled module
contract from
`notes/2026/2026-07/2026-07-23/grill-module-webrun-modules.md` — as an OpenSpec
capability so the guarantees (above all: **no runtime CDN**) are pinned and
regression-checked. It does **not** rewrite the working implementation.

## What Changes

- Add the `webrun-modules` capability spec: one isomorphic **dependency server**
  that, given a TS/JS entry, resolves + downloads + transforms the full
  dependency graph **from NPM at resolve-time only** and serves browser-runnable
  ESM from a local `FilesApi` cache, with every internal import rewritten to a
  **same-origin** local URL.
- One **resolver core** over one injected `FilesApi` cache, exercised two ways:
  eager `prime(entry)` (warm the whole graph, write the lockfile) and lazy
  `server.fetch` (a standard `(Request) => Promise<Response>` handler,
  resolve-on-miss, mountable under a `basePath`).
- Two pluggable seams: **`Source`** (acquisition; default = npm registry tarball,
  untarred in memory) and **`Transform`** (per-file TS/JSX/CJS→ESM with specifier
  rewriting). Authored source and dependency files pass through the *same*
  per-file transform — they differ only in origin.
- Subsumes the earlier `webrun-app-runtime` sketch: one Seam-2 engine owns
  authored source **and** the dependency graph; hosting (`webrun-site-builder` /
  `webrun-site-host`) stays orthogonal and attaches via `server.fetch`.

## Impact

- Affected spec: `webrun-modules` (new capability).
- Affected code: `packages/webrun-modules` (already implemented — this change
  documents and locks its contract; no behavioural rewrite).
- Out of scope (deferred): bundling / copying the resolved graph into a
  distributable tree; serving `.d.ts` types; running package lifecycle/install
  scripts; HMR/watch of pinned deps.
