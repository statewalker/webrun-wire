// Fixture page: registers the real ServiceWorker via `@statewalker/webrun-http-browser/sw`,
// mounts `newPubSub().handler` behind it, and subscribes to it with `newPubSubClient` — the
// full page -> ServiceWorker -> EventSource path this package exists for. Everything it does
// is recorded on `window` so the Node-side Playwright test can read it back.
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { newPubSubClient } from "../../src/client.js";
import { newPubSub } from "../../src/handler.js";

const KEY = "events";
const adapter = new SwHttpAdapter({ key: KEY, serviceWorkerUrl: "/sw-worker.js" });
await adapter.start();

const ps = newPubSub();
const { baseUrl } = await adapter.register(`${KEY}/`, (request) => ps.handler(request));

(window as any).__received = [];
(window as any).__gaps = 0;
const client = newPubSubClient(`${baseUrl}_events`, {
  // This fixture publishes under the `rebuilt` name; a named SSE event is never
  // dispatched as `message`, so the name has to be listed for anyone to see it.
  events: ["message", "rebuilt"],
  onGap: () => void (window as any).__gaps++,
});
client.subscribe("build", (data) => (window as any).__received.push(data));

// Exposed for the "two concurrent subscribers" test, which drives publish/subscribe
// directly from page context rather than through the tick loop below.
(window as any).__ps = ps;
(window as any).__client = client;

// Publish once a second so the test can measure delivery across the SW idle window.
let n = 0;
(window as any).__published = 0;
setInterval(() => {
  ps.publish("build", { tick: ++n }, "rebuilt");
  (window as any).__published = n;
}, 1000);

(window as any).__ready = true;
