---
"@statewalker/webrun-http-browser": patch
---

Relay ServiceWorker: REGISTER and UNREGISTER calls on the same key now run one after another, so two pages registering a key at the same moment under `takeover: "first-wins"` no longer both succeed (the first keeps the key, the second gets `"<key>" is already served by another client`).
