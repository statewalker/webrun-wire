// The relay ServiceWorker for the mounts fixture (see tests/browser/).
//
// It MUST be served from this directory: its scope is `./`, so the paths it
// sees are `/tests/fixtures/browser/mounts/...`, and the mounts the host page
// registers are written in those terms.
//
// A root mount claims EVERY path under the scope, so without `exclude` it
// would claim this origin's own files -- the host page, the relay page and
// this very worker script -- and the origin could not bootstrap at all. That
// is what the `reserved.txt` scenario pins.
const BASE = "/tests/fixtures/browser/mounts/";
const RESERVED = new Set([
  `${BASE}index.html`,
  `${BASE}relay.html`,
  `${BASE}relay-sw.js`,
  `${BASE}reserved.txt`,
]);

self.RELAY_OPTIONS = {
  exclude: (url) => RESERVED.has(url.pathname),
  takeover: "first-wins",
};

importScripts("/dist/relay-sw.js");
