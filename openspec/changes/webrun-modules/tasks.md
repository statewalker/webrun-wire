# Tasks: webrun-modules

The engine already exists in `packages/webrun-modules` and drives `notes-demo`;
this change formalizes and locks its contract. Tasks below record the contract
capture and verification, not a from-scratch build.

## 1. Contract capture

- [x] 1.1 Write the capability spec (`specs/webrun-modules/spec.md`) from the
      grilled contract note (Purpose, seams, URL contract, target/cache-key,
      failure paths).
- [x] 1.2 Record the spike-gated design decisions (CJS interop, version dedupe,
      conditional resolution, prefix portability) in `design.md`.

## 2. Contract verification (against the existing implementation)

Each maps to a spec requirement; all run against real spawned behaviour with
`MemFilesApi` (and at least one with `NodeFilesApi`), never against mocks of the
code under test.

- [x] 2.1 **No runtime CDN** — after `prime`, no `esm.sh`/`jsdelivr`/`unpkg`/
      `registry.npmjs.org` URL survives in served output; importing the entry
      triggers zero cross-origin fetches.
- [x] 2.2 **ESM → importable local URL** — internal bare specifiers rewritten to
      `/{name}@{version}/…`; no bare specifiers remain.
- [x] 2.3 **Eager `prime` warms the transitive graph** — entry executes after
      `prime` with the network disabled.
- [x] 2.4 **Version dedupe** — compatible ranges share one cached version;
      incompatible ranges keep both pinned versions side by side, no hard fail.
- [x] 2.5 **Conditional exports honour `target`** — browser vs node entries
      selected and cache-keyed distinctly.
- [x] 2.6 **Node builtins under browser target** — `node:path`/bare `path` map to
      self-hosted polyfill URLs; stay external under node target.
- [x] 2.7 **CJS interop** — CJS package resolves to importable ESM with matching
      named exports; unsupported dynamic `require` surfaces a typed
      `ModuleTransformError` (or the declared bundle fallback).
- [x] 2.8 **Individual raw file access** — any file inside a cached package is
      fetchable as untransformed bytes, distinct from the transformed ESM.
- [x] 2.9 **Local-script scenario** — a project `.ts` script is transpiled;
      relative imports stay relative-local, bare imports get rewritten.
- [x] 2.10 **Lockfile persistence** — reload with same entry + pins does not
      re-solve; changing a pin re-solves.
- [x] 2.11 **`server.fetch` conformance** — correct `Content-Type`, raw-vs-
      transformed selection on one path, `404` `Response` (not a throw).
- [x] 2.12 **Isomorphic core** — same resolver passes with `MemFilesApi` and
      `NodeFilesApi` (backend swap only).
- [x] 2.13 **Prefix-mountable & portable** — served under `basePath:"/deps/v1/"`
      every request resolves and returned URLs carry the prefix; same cached
      bytes serve under a different prefix with no re-transform.

## 3. Deferred (explicitly out of scope here)

- [ ] 3.1 Bundling / copy-out of the resolved graph into a distributable tree.
- [ ] 3.2 Serving `.d.ts` TypeScript types.
