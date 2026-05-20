# webrun-wire

Move `Request`/`Response` and async iterators over any byte channel, and host
ordinary `(Request) ⇒ Response` handlers in a browser tab via ServiceWorker.
Adjacent in-browser build pipeline work simulates client + server execution
without a network server.

## Language

### Wire / transport

**SiteHandler**:
The canonical `(request: Request) => Promise<Response>` seam between a site
definition and any platform host (browser SW, MessagePort, Node, etc.). See
ADR 0003.
_Avoid_: handler, request handler

**SiteBuilder**:
Deep module that owns *what* a site does — files, endpoints, auth, routing —
and produces a **SiteHandler**.

**HostedSiteBuilder**:
Thin platform adapter that owns *where* a site runs in the browser; takes a
**SiteHandler** via `setHandler` and registers a ServiceWorker.

**SwHttpAdapter**:
The ServiceWorker-side fetch interceptor that turns SW `fetch` events into
calls to a **SiteHandler**.

**FilesApi**:
Read/write interface for a byte store (memory, OPFS, Node FS, virtual mount).
Sites mount one or more **FilesApi** instances under URL prefixes.

### P2P mesh (`webrun-p2p-mesh`)

**Mesh**:
Long-lived runtime built by `MeshBuilder`. Owns one libp2p node, joins one
group, runs gossipsub-based peer discovery, and accepts the registration of
peer-proxy handlers. No HTTP semantics of its own — it is the substrate the
two peer proxies plug into.

**Server peer proxy**:
A **SiteHandler** produced by `ServerPeerProxyBuilder`. Runs on the peer
that *offers* an HTTP resource. Receives an inbound peer call (deserialised
from libp2p by the mesh) and forwards it to an external HTTP target —
typically a localhost service such as Matrix, Ollama, LM Studio.
Reverse-proxy direction.
_Avoid_: gateway, server side, inbound handler.

**Client peer proxy**:
A **SiteHandler** produced by `ClientPeerProxyBuilder`. Runs on the peer
that *calls* a remote HTTP resource. Receives a local `Request` and forwards
it to a configured `peerId` over libp2p. Forward-proxy direction.
_Avoid_: consumer, client side, outbound handler.

**Group**:
A peer-discovery scope identified by a `groupId`. Two gossipsub topics keep
the group together: `webrun/<groupId>/peer-discovery` (off-the-shelf
multiaddr broadcast) and an application-level capability catalog (shape
inherited from `apps/p2p-demo/lib/announcement.ts`, possibly sharpened
in this package).

### In-browser build pipeline (Step 1 = `site-builder-tsx-spike`)

**First-party source**:
User-authored `.ts` / `.tsx` / `.js` / `.css` bytes held in a **FilesApi**
mounted at `/client` or `/server`. Owned by the user; the builder treats it
as input. **Both first-party source and CDN content are rewritten inline** —
every import specifier (bare or absolute CDN URL) is replaced with an
**external mount** path.

**Source package.json**:
A `package.json` sitting inside the **first-party source** FilesApi. Its
`dependencies` field is the lockfile fed to the **resolver** for pinning.

**CDN content**:
Third-party bytes fetched from the JSPM CDN (`ga.jspm.io`) to back the
**external mount**. Every internal reference is rewritten to another
**external mount** path before being cached and served.

**External mount**:
The same-origin path `/<siteKey>/external/<pkg>@<v>/<file>` under which all
third-party bytes are served. Browser-visible URL space — never cross-origin
from the iframes. Internal references to **external mount** files are
expressed as **relative URLs** computed from the importing module's
location (e.g. `../external/...` from `/client/`), so the bundle is
mount-prefix-agnostic and drop-deployable as a static export.

**Resolver**:
The component, built around `@jspm/generator`, that takes the **source
package.json** plus the set of **bare specifiers** discovered by the
**lex pass** and produces a **resolution manifest** — a `bare specifier →
external mount path` table. Runs in the host page main thread.
_Avoid_: linker, dependency resolver

**Resolution manifest**:
A JSON import map emitted as a sidecar artifact of the **resolver**. Records
`bare specifier → /external/...` mappings. Inspectable, consumable by future
bundling tools — **not** load-bearing at runtime, since imports are
rewritten inline before being served to any **realm**.
_Avoid_: lockfile (which has a different role — see **Source package.json**)

**Bare specifier**:
An npm package name without a scheme (`react`, `lodash/fp`). Cannot be loaded
by browsers unless rewritten by the **lex pass**.

**Realm**:
A distinct browser module-loader scope. The host page is one realm; the
client preview iframe is another. The in-browser build pipeline demos run
the server module in the **host page realm** via `setServerRunner` — its
imports are already rewritten, so the host realm executes them directly
without an import map.

**Lex pass**:
A use of `es-module-lexer` that walks bytes once already-transpiled to JS
(post-sucrase for `.ts`/`.tsx`), discovers every import specifier, and
inline-rewrites each one to a **relative** **external mount** path
computed from the importing file's own location. Same pass applies to
**first-party source** and **CDN content**, recursively.

## Pipeline

```
.ts / .tsx / .jsx
   │
   ▼ sucrase
.js with bare specifiers
   │
   ▼ lex pass (es-module-lexer)
.js with every import rewritten to ../external/<pkg>@<v>/<file>
                                    (relative to the importing file)
```

Drives — and is driven by — the **resolver**:

```
discovered bare specifiers ──▶ @jspm/generator + source package.json
                                       │
                                       ▼
                              resolution manifest
                              (bare ⇒ external mount entry)
                                       │
                            ┌──────────┴─────────┐
                            ▼                    ▼
              inline rewrite of source     /external/* fetch + recurse
```

## Relationships

- A **SiteBuilder** produces a **SiteHandler**.
- A **HostedSiteBuilder** consumes a **SiteHandler** and registers a SW.
- The **external mount** is itself a **FilesApi** that fetches via JSPM CDN
  and caches.
- The **resolver** consumes one **source package.json** plus all **bare
  specifiers** observed by the **lex pass** over **first-party source**,
  and emits one **resolution manifest**.
- A **realm** loads bytes through the **SiteHandler**; first-party imports
  are already pointing at **external mount** paths at fetch time, so no
  runtime resolver runs in the realm.

## Flagged ambiguities

- "import map" initially used loosely. Resolved: the only import-map
  artifact in this pipeline is the **resolution manifest**, a sidecar
  JSON — not a `<script type="importmap">` in any realm.
- "server-side" was used to mean both "a Node process" and "code that
  fulfills HTTP requests in the in-browser model". Resolved: in this
  codebase, "server-side" is code reached via `setServerRunner` — it runs
  in the **host page realm** in the in-browser build pipeline demos.
- "es-module-shims" and "es-module-lexer" were initially treated as
  alternatives. Resolved: only the lexer is used in the pipeline; the
  shim was explored and dropped because inline rewriting removes its job.
- "rewrite" applies to both first-party and CDN content uniformly in the
  current design; an earlier draft distinguished them.
