// A relay worker that refuses any mount at a path naming `index.html`, to
// show `canRegister` sees where a key lands (#13).
self.RELAY_OPTIONS = {
  canRegister: (_client, _key, path) => !(path ?? "").includes("index.html"),
};
importScripts("/dist/relay-sw.js");
