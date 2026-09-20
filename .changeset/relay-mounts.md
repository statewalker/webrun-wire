---
"@statewalker/webrun-http-browser": minor
---

Relay services can be mounted at a path, including the origin root, with keys
and paths chosen by the host and carried on REGISTER. Several services can
share one relay connection: a CONNECT is routed to the service named by its
key, so an app at `/` and a gateway at `/peers/` can register over the same
port without answering each other's calls. Routing is by longest matching
prefix, and the matched prefix is NOT stripped — a handler mounted at
`/peers/` receives `/peers/…`.

A request matching no mount is not the relay's: the worker does not call
`respondWith` for it at all, so the browser performs it exactly as it would
with no worker installed, and a host keeps serving its own files. (Requests
arriving in the moment before the registry has been read back are the one
exception: the table cannot be consulted synchronously yet, so they are
claimed and re-issued.) `exclude` reserves paths from a root mount — and from
the `/~<key>/` spelling too — and must also cover the host's own entry page,
not just the relay page and worker script, or a reload cannot get past a root
mount.

A mount declared in `mounts` belongs to the host: a page's REGISTER or
UNREGISTER naming the same key never replaces or removes it, so the page can
register with no `path` of its own. A mount an earlier REGISTER created is
still replaced by a path-ful REGISTER and removed by a path-less one.

New: `@statewalker/webrun-http-browser/relay-worker`, the relay worker
runtime as a typed ES module — `startRelayServiceWorker`, with
`RelayServiceWorkerOptions` and `MountSpec` — for a host that bundles its own
worker, and for typing `self.RELAY_OPTIONS`. The prebuilt `dist/relay-sw.js`
still reads its options from `self.RELAY_OPTIONS`, set by the host's own
worker script before `importScripts`, since a classic worker cannot otherwise
receive arguments. New options: `mounts`, `exclude`, `canRegister`,
`takeover`, `decorateResponse`. Mounting at `/` should be paired with
`takeover: "first-wins"` and `canRegister`.

Fixes: `splitServiceUrl` treated any URL containing `~` as a service URL,
including `?q=~foo`; it is now anchored to the pathname, and it still splits
root-relative input (`/~FS/a/b`), which anchoring had broken. Registrations
record `{ clientId, path }`, and the earlier bare-client-id shape is still
read, so a returning visitor's services survive. A connection carrying more
than one registered service had every `CONNECT` answered by every service,
colliding on the same transferred port; a `CONNECT` is now delivered only to
the service named by its key.
