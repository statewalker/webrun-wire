# @statewalker/notes-demo

An **app-agnostic in-browser runner** plus a **notes CRUD example payload**.

The runner (`src/`) reads a client/server **TypeScript** app from a `FilesApi`,
transpiles both parts and resolves their npm dependencies to **same-origin**
module URLs with `@statewalker/webrun-modules` (`newModuleServer`) — **no runtime
CDN, no import map** — then hosts the result behind a same-origin ServiceWorker
(`SiteBuilder` → `HostedSiteBuilder`) and shows the client UI in an iframe.

The runner contains **zero** notes-specific logic. The notes app (`src/app/`) is
just the bundled payload; replacing it with any other client/server app that
honors the workspace convention (`/package.json`, `/server/index.ts`,
`/client/index.html`) requires no runner change.

## Run

```sh
pnpm --filter @statewalker/notes-demo dev     # then open the printed localhost URL
pnpm --filter @statewalker/notes-demo build   # production bundle in dist/
pnpm --filter @statewalker/notes-demo test    # hermetic vitest suite (no network)
```

On first load the runner downloads `react`, `react-dom`, and `marked` from the
npm registry (dev-time online required once); they are cached in memory for the
session. The unit tests are fully hermetic.

### The run story

1. Parse `#storage` → pick the workspace backend.
2. `ensureWorkspace` seeds the payload into the workspace (once).
3. `deriveLock` reads the payload `/package.json` → an **exact** lockfile.
4. `newModuleServer` transpiles/resolves the payload on demand.
5. `SiteBuilder` wires `/api/*` (the server module) and `/*` (the module server)
   and `HostedSiteBuilder` mounts it behind the SW.
6. The iframe loads `<baseUrl>~/client/index.html`.

## The `~/` URL scheme

The module server serves project (payload) files under a **`~/` prefix** and npm
packages at `<name>@<version>/<file>`:

- `/~/client/index.html`, `/~/client/main.tsx` — the payload client.
- `/~/server/index.ts` — the payload server entry (dynamic-imported per `/api`
  request by `newServerRunner`).
- `/react@18.3.1/index.js`, `/marked@15.0.4/…` — resolved npm deps, same-origin.

All imports are rewritten to same-origin **relative** URLs; nothing is fetched
from a CDN at runtime.

## Storage: `#storage=mem` (default) | `#storage=opfs`

- **Mem** (default) — an in-memory `MemFilesApi`; notes reset on reload.
- **OPFS** — `#storage=opfs` uses `getOPFSFilesApi()` from
  `@statewalker/webrun-files-browser`; notes persist across reloads (secure
  context required — localhost qualifies).

Notes are stored as markdown-with-frontmatter files at `/data/notes/<id>.md`.

### OPFS seed-staleness caveat

Seeding is idempotent: it writes the payload only when `/package.json` is absent,
and never touches `/data`. On OPFS the payload is therefore seeded **once** and
reused. If you edit the payload after an OPFS seed, the change will **not** appear
until you reset storage — clear the origin's OPFS (DevTools → Application →
Storage) or switch to `#storage=mem`.

## Verifying no-CDN in DevTools

Open DevTools → Network and reload. Every module request — including `react`,
`react-dom`, and `marked` — is served from **this origin** (the ServiceWorker /
module server). There is **no** request to any CDN host and **no** import map in
the page. The dependency versions match the payload `src/app/package.json` pins.
