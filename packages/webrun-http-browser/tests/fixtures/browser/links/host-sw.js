// A host's own module ServiceWorker that listens to `fetch` itself (`handleFetch: false`): its own
// routes first, then whatever is the dispatcher's, with a page of its own for urls nobody serves.
import { SwHttpDispatcher } from "/dist/sw.js";

const dispatcher = new SwHttpDispatcher({
  self,
  log: console.log,
  handleFetch: false,
  // A request the dispatcher took that no handler serves (an unserved navigation, say).
  unserved: (request) =>
    new Response(`host page for ${new URL(request.url).pathname}`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
dispatcher.start();

// What handleFetch returned, per path, for the test to read.
const returned = [];

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // A route of the host's own, under the scope but nobody's key.
  if (url.pathname.endsWith("/host/hello")) {
    event.respondWith(new Response("from the host"));
    return;
  }
  if (url.pathname.endsWith("/host/returned")) {
    event.respondWith(Response.json(returned));
    return;
  }
  // The host may even take a request that a handler would answer.
  if (event.request.headers.get("x-host") === "take") {
    event.respondWith(new Response("the host took it"));
    return;
  }
  // ?tunnel: the host adds a header of its own (a tunnelled cookie, say) before dispatching.
  let request = event.request;
  if (url.searchParams.has("tunnel")) {
    const headers = new Headers(request.headers);
    headers.set("x-tunnel", "from-host");
    request = new Request(request, { headers });
  }
  // `settled`: whether the stored keys were read already (`_restoreSettled` is private to the
  // TypeScript API; read here so the test can tell the branch handleFetch took).
  const settled = dispatcher._restoreSettled;
  returned.push({ path: url.pathname, settled, handled: dispatcher.handleFetch(event, request) });
});
