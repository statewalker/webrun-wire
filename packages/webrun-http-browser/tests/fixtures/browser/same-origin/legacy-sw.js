// The library's same-origin worker with the CLAIM request swallowed — what a
// page talks to when its worker predates that request, or will not claim.
// Registered before the library's own listeners, so it runs first.
self.addEventListener("message", (event) => {
  if (event.data?.type === "CLAIM") event.stopImmediatePropagation();
});
importScripts("/dist/sw-worker.js");
