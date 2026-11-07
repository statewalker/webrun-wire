// A host's own module ServiceWorker that listens to `fetch` itself (`handleFetch: false`): its own
// routes first, then whatever is the dispatcher's.
import { SwHttpDispatcher } from "/dist/sw.js";

const dispatcher = new SwHttpDispatcher({ self, log: console.log, handleFetch: false });
dispatcher.start();

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // A route of the host's own, under the scope but nobody's key.
  if (url.pathname.endsWith("/host/hello")) {
    event.respondWith(new Response("from the host"));
    return;
  }
  // The host may even take a request that a handler would answer.
  if (event.request.headers.get("x-host") === "take") {
    event.respondWith(new Response("the host took it"));
    return;
  }
  dispatcher.handleFetch(event);
});
