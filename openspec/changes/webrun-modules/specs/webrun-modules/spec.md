# webrun-modules

## ADDED Requirements

### Requirement: No runtime CDN dependency

The module server SHALL serve every module in a resolved graph from its local
`FilesApi` cache as same-origin content. It MAY fetch from NPM (or a CDN) only at
resolve-time; the served result SHALL contain no reference that causes a running
app to fetch a module from a third-party origin.

#### Scenario: primed graph is fully same-origin

- **WHEN** `prime(entry)` has completed for an entry with transitive npm deps
- **THEN** no `esm.sh`, `jsdelivr`, `unpkg`, or `registry.npmjs.org` URL appears
  anywhere in the transformed output served for that graph
- **AND** importing the entry URL triggers zero cross-origin network fetches

### Requirement: ESM resolves to an importable local URL

The server SHALL resolve an ESM package reference to a directly `import`-able,
same-origin URL of the form `/{name}@{version}/{subpath}` (version always pinned,
never a range), rewriting every internal bare specifier to a same-origin local
URL.

#### Scenario: bare specifiers are rewritten

- **WHEN** `resolve({ pkg })` returns a `ResolvedModule` for an ESM package
- **THEN** the returned `url` is a pinned `/{name}@{version}/…` local URL
- **AND** no bare specifier remains in the transformed module it addresses

### Requirement: Eager prime warms the transitive graph

`prime(entry)` SHALL walk the entry's whole dependency graph, transform every
reachable file, and write the resolution lockfile to the cache, such that the
entry executes with no further network access.

#### Scenario: entry runs with the network disabled

- **WHEN** `prime(entry)` completes and the network is then disabled
- **THEN** importing and executing the entry URL succeeds using only cached
  modules

### Requirement: Version dedupe with side-by-side conflicts

During `prime` the server SHALL pick one resolved version per package name where
semver constraints allow, and SHALL keep genuinely incompatible versions of the
same package side by side (each under its own pinned path) rather than failing.

#### Scenario: compatible ranges share one version

- **WHEN** two dependencies request compatible ranges of one package
- **THEN** a single cached version is shared by both

#### Scenario: incompatible ranges are both pinned

- **WHEN** two dependencies request genuinely incompatible ranges (e.g. `17` and
  `18`) of one package
- **THEN** both pinned versions are cached side by side without error

### Requirement: Conditional exports honour the target

The server SHALL select `exports`/`imports` conditions by an explicit `target`
(default `"browser"`), and SHALL include `target` in the cache key so a browser
build and a node build of the same file do not collide.

#### Scenario: browser and node entries are distinct

- **WHEN** a package with `browser`/`node` conditional `exports` is resolved under
  `target:"browser"` and under `target:"node"`
- **THEN** each serves its respective conditional entry
- **AND** the two cache entries do not collide

### Requirement: Node builtins under the browser target

The server SHALL resolve imports of Node builtins (both `node:path` and bare
`path`) to self-hosted, same-origin polyfill URLs under the browser target, and
SHALL keep them external under the node target.

#### Scenario: browser target polyfills node builtins

- **WHEN** a module imports `node:path` (or bare `path`) under `target:"browser"`
- **THEN** the specifier resolves to a same-origin polyfill URL, not a bare or
  cross-origin specifier

### Requirement: CJS interop

The server SHALL transform a CommonJS package into importable ESM whose named
exports match the package's exports. When a file uses dynamic/computed `require`
that the interop runtime cannot safely handle, the server SHALL either apply the
declared bundle fallback or throw a typed `ModuleTransformError`.

#### Scenario: CJS named exports interop

- **WHEN** a CJS package is resolved and primed
- **THEN** it imports as ESM and its named exports match the package's exports
- **AND** it executes correctly

#### Scenario: unsupported dynamic require is typed

- **WHEN** a CJS file uses a dynamic/computed `require` the interop cannot handle
  and no bundle fallback applies
- **THEN** the server throws `ModuleTransformError` carrying the file path and a
  reason

### Requirement: Individual raw file access

The server SHALL expose every file inside a cached package as untransformed bytes
at its package-relative path, distinct from the transformed ESM served on the same
logical path.

#### Scenario: raw bytes differ from transformed ESM

- **WHEN** a cached package file is requested as raw bytes and as a module on the
  same path
- **THEN** the raw request returns the original untransformed bytes and the module
  request returns the transformed ESM

### Requirement: Local-script scenario

A script served from the injected `project` `FilesApi` SHALL be transpiled by the
same per-file transform, with its **relative** imports kept relative-local and its
**bare** imports rewritten to `/{name}@{version}/…` local URLs.

#### Scenario: project script keeps relatives, rewrites bares

- **WHEN** a `.ts` script served from `project` is resolved
- **THEN** its relative imports remain relative-local
- **AND** its bare imports are rewritten to pinned package URLs

### Requirement: Lockfile persistence

`prime` SHALL persist the resolution map to the cache; a reload with the same
entry and pins SHALL load that map and not re-solve the graph. The server SHALL
re-solve only when the entry's declared dependency set or the input `lock`
changes.

#### Scenario: reload does not re-solve

- **WHEN** `prime(entry)` has run and the server is reloaded with the same entry
  and pins
- **THEN** the resolution map is loaded from the cache and no re-solve occurs

#### Scenario: changed pin re-solves

- **WHEN** an input pin is changed
- **THEN** the affected graph is re-solved

### Requirement: server.fetch is a conformant Web handler

The server SHALL expose `fetch(request)` as a standard
`(Request) => Promise<Response>` that serves modules with `Content-Type:
text/javascript`, selects raw-vs-transformed content on one path, and returns a
`404` `Response` (never throwing) for an unresolvable path.

#### Scenario: correct content type and 404

- **WHEN** a resolvable module path is fetched
- **THEN** the response carries a JavaScript content type
- **WHEN** an unresolvable path is fetched
- **THEN** a `404` `Response` is returned rather than an exception

### Requirement: Isomorphic core

The resolver core SHALL run unchanged over any injected `FilesApi` backend. The
same behaviour SHALL hold with `MemFilesApi` and with `NodeFilesApi` (backend swap
only, no code change).

#### Scenario: same behaviour across backends

- **WHEN** the resolver is exercised with `MemFilesApi` and then with
  `NodeFilesApi`
- **THEN** both produce the same resolution/serving behaviour

### Requirement: Prefix-mountable and portable

The server SHALL accept a `basePath` (default `"/"`) and match/serve under any
prefix. Returned URLs SHALL carry the prefix, and internal module-to-module
imports SHALL be baked as relative URLs so the same cached bytes serve under a
different prefix with no re-transform.

#### Scenario: served under a prefix

- **WHEN** the server is configured with `basePath:"/deps/v1/"`
- **THEN** every request resolves under that prefix and returned URLs carry it

#### Scenario: cached bytes are prefix-portable

- **WHEN** the same cached bytes are served under a different prefix
- **THEN** they serve correctly without re-transformation
