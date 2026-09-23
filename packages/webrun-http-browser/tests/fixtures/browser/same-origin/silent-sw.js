// A worker that takes control but is not this package's dispatcher: it never
// answers the adapter's UPDATE_COMMUNICATION_PORT handshake.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
