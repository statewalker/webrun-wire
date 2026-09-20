---
"@statewalker/webrun-http-browser": minor
---

Relay services can be mounted at a path, including the origin root, with keys
and paths chosen by the host and carried on REGISTER. Unmatched requests go to
the network rather than being answered, so a host keeps serving its own files;
`exclude` reserves them from a root mount, and must also cover the host's own
entry page, not just the relay page and worker script, or a reload cannot get
past a root mount. Several services can share one relay connection: a CONNECT
is routed to the service named by its key, so an app at `/` and a gateway at
`/peers/` can register over the same port without answering each other's
calls. The prebuilt `dist/relay-sw.js` reads its options from
`self.RELAY_OPTIONS`, set by the host's own worker script before
`importScripts`, since a classic worker cannot otherwise receive arguments.
New options: `mounts`, `exclude`, `canRegister`, `takeover`,
`decorateResponse`.

Fixes: `splitServiceUrl` treated any URL containing `~` as a service URL,
including `?q=~foo`; it is now anchored to the pathname. Registrations record
`{ clientId, path }`, and the earlier bare-client-id shape is still read. A
connection carrying more than one registered service had every `CONNECT`
answered by every service, colliding on the same transferred port; a
`CONNECT` is now delivered only to the service named by its key.
