# consumer-install

## What it is

A private Vitest harness (`@statewalker/consumer-install-tests`) that installs packages of this
repository the way an outside consumer does: from packed tarballs, with npm, into a scratch
directory, and then imports every export subpath under Node.js. It currently targets
`@statewalker/webrun-http-browser`.

## The shape

```
consumer-install.test.ts
  PACKAGES                  targets: name, directory, export subpaths, browser-only subpaths
  workspaceClosure(target)  the target plus every packages/* package it depends on, transitively
  installFromTarball()      pnpm pack each package of the closure -> npm install all tarballs
                            into a fresh temp directory
vitest.config.ts            15-minute test and hook timeouts
```

## How to run it

It runs as part of `pnpm test` at the repository root. To run it alone:

```sh
pnpm --filter @statewalker/consumer-install-tests test
```

## Why it is the way it is

Tests inside the workspace resolve `@statewalker/*` to `src/`, so they never see what npm users
get. This harness checks the published shape instead:

1. The target's `PACKAGES` entry lists exactly the subpaths of its `exports` map.
2. The installed package contains `dist/` and every file its `exports` map names; every subpath
   that is not marked browser-only imports under Node and exports something.
3. The installed `package.json` keeps no `workspace:` or `catalog:` range, which npm cannot install.
4. If the target declares `@statewalker/webrun-files` as a peer, installing its latest release
   does not fail with `ERESOLVE`.

The whole workspace closure is packed from the working tree, not just the target. Otherwise
`pnpm pack` would rewrite the target's dependency on a sibling to the sibling's local version, and
`npm install` would fetch that version from the registry: the test would certify a mix of working
tree and registry, and fail with a 404 as soon as a local version is ahead of npm.

## What will surprise you

- **It needs the network.** `npm install` fetches third-party dependencies (such as `idb-keyval`)
  from the npm registry.
- **It is slow.** Every `pnpm pack` runs that package's `prepack` build, and each install is a real
  `npm install`. Expect minutes.
- **Browser-only subpaths are not imported.** `./sw`, `./relay-sw`, `./relay-worker` and
  `./sw-worker` of `webrun-http-browser` are only checked for existence, because they cannot load
  under Node.

## Reference

| Command | What it runs |
| --- | --- |
| `pnpm --filter @statewalker/consumer-install-tests test` | `vitest run` on `*.test.ts` in this directory |
