---
"@statewalker/webrun-http-browser": minor
---

Relay handshake robustness and leaks:

- The relay page accepts a `CONNECT` only from its embedding window (`window.parent`), and `newRemoteRelayChannel` posts it to the relay's origin instead of `"*"`.
- New `newRemoteRelayChannel({ timeout })`: waits for the relay page to acknowledge the connection and rejects (removing the iframe) when it does not, e.g. a missing or `frame-ancestors`-blocked `relay.html`. The acknowledgement travels on an optional second port that older relay pages ignore; leave `timeout` unset with them. Without `timeout` nothing changes, except that an iframe load failure is no longer an unhandled rejection.
- A relay worker that fails to start no longer surfaces as an unhandled rejection, and a later `CONNECT` is accepted and retries.
- `newServiceWorkerPort(registration, { signal })`: aborting the signal (or closing the port, where the browser reports it) removes its `navigator.serviceWorker` listener, which previously leaked.
- The relay worker drops the mount of a holder it finds gone together with its registry entry, so its path falls through to the network instead of answering 410 until the worker restarts.
- `handleStreams` delivers a failing handler's error to the caller instead of an empty stream plus an unhandled rejection.
- `package.json` lists `./relay-sw` and `./sw-worker` under `sideEffects`, so bundlers keep a bare import of them.
