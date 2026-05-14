# 3. `SiteHandler` is the canonical site/host seam

Date: 2026-05-14

## Status

Accepted.

## Context

`webrun-site-builder` and `webrun-site-host` shipped together with the
intention that the first defines a site, the second hosts it in the
browser via a ServiceWorker. In practice both packages grew the same
configuration surface: `setEndpoint`, `setFiles`, `setAuth`,
`setErrorHandler`, `setServerRunner` all existed on both `SiteBuilder`
and `HostedSiteBuilder`. The reason was ergonomic — callers wanted one
fluent chain — but the implementation cost was real:

- `HostedSiteBuilder` carried five parallel state buckets (`#endpoints`,
  `#filesMounts`, `#serverRunners`, `#auths`, `#errorHandler`).
- `#buildSiteHandler` (19 lines) iterated those buckets and forwarded
  each entry to a freshly-constructed `SiteBuilder`. Pure pass-through.
- Every new platform host (Node, Deno, Bun, MessagePort, Workers) faced
  a choice: duplicate the surface a third time, or break the ergonomic
  symmetry. Neither was attractive.

The deletion test made it clear: removing `HostedSiteBuilder.setEndpoint`
would not destroy any complexity — the same code would relocate to one
call site that built a `SiteBuilder` directly. The depth lived entirely
in `SiteBuilder`. `HostedSiteBuilder` had ~30 useful lines (SW
registration, URL rewriting) wrapped in ~80 lines of pass-through
plumbing.

## Decision

`SiteHandler = (request: Request) => Promise<Response>` is the canonical
seam between site definition and platform hosting:

- `SiteBuilder` is the deep module. It owns *what* a site does:
  endpoints, files, auth, routing. It produces a `SiteHandler`.
- `HostedSiteBuilder` (and any other `*SiteBuilder`) is a thin platform
  adapter. It owns *where* a site runs. Its only configuration knob for
  site behaviour is `setHandler(handler: SiteHandler)`.

Concretely, after this change:

- `HostedSiteBuilder` exposes exactly: `setSiteKey`, `setServiceWorkerUrl`,
  `setHandler`, `build`. The configuration methods inherited from
  `SiteBuilder`'s surface are removed.
- `PortSiteBuilder` (new, in `webrun-http-port`) is the first sibling.
  Same shape: `setHandler(handler).start()`. Hosts the handler over a
  `MessagePort` via `serveFetchOverPort`.
- Future hosts (`NodeSiteBuilder`, `DenoSiteBuilder`,
  `WorkerSiteBuilder`, …) follow the same pattern — each is ~30 LOC of
  platform glue.

## Consequences

- The same `SiteHandler` works in every host without modification. A
  site defined once can be exposed simultaneously in the browser
  (via SW), to a remote peer (via a `MessagePort` adapter), and on a
  Node HTTP listener — same handler, three hosts.
- Cross-application HTTP becomes a one-liner: the client app's
  `HostedSiteBuilder` registers `setHandler(req => fetchOverPort(port, req))`,
  forwarding every fetch through a `webrun-port-*` adapter to a peer
  app's `PortSiteBuilder`. No domains, no certificates required.
- The duplicated configuration surface is gone from `HostedSiteBuilder`.
  About 80 LOC removed; ~30 LOC of platform-specific code remains.
- **BREAKING** for direct consumers of the old `HostedSiteBuilder`
  configuration methods. The umbrella's two demo apps were the only
  consumers; both were migrated in the same change.

## Alternatives considered

1. **Soft-deprecate the configuration methods on `HostedSiteBuilder`**
   (keep them as `@deprecated` shims that internally build a
   `SiteBuilder`). Rejected: preserves the duplicated API surface for
   another release cycle, defeating the simplification.

2. **Promote a separate `SiteHandlerLike` interface** distinct from
   `SiteHandler` to allow drift between the two types over time.
   Rejected: one type is better than two structurally-identical types;
   the existing `SiteHandler` is already correctly named and exported.

3. **Add `NodeSiteBuilder` / `DenoSiteBuilder` in the same change**
   to demonstrate the family. Rejected as scope creep: those siblings
   are easy follow-ups, but each carries platform-specific concerns
   (which HTTP server, port binding semantics, signal handling) that
   are not load-bearing for the seam fix.
