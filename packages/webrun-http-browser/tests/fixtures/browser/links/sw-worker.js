// The library's same-origin worker, with options from the script url:
// ?attach=<ms> sets attachTimeoutMs, ?route=slot routes by the `x-slot` header.
const params = new URL(self.location.href).searchParams;
self.HTTP_DISPATCHER_OPTIONS = {
  attachTimeoutMs: Number(params.get("attach") ?? 15000),
  relinkTimeoutMs: 3000,
  handoverMs: 5000,
};
if (params.get("route") === "slot") {
  self.HTTP_DISPATCHER_OPTIONS.route = (request, _key, handlers) => {
    const slot = request.headers.get("x-slot");
    return slot ? handlers.find((handler) => handler.id === slot) : handlers[0];
  };
}
importScripts("/dist/sw-worker.js");
