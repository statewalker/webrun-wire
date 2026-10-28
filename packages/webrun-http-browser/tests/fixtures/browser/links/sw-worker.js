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
if (params.has("count")) {
  // ?count: every body handed to `respondWith` is counted as Chromium pulls
  // it, so a test can tell what this package holds (handler output not yet
  // handed over) from what Chromium buffers (handed over, not yet read). The
  // wrapper pulls one chunk per pull (highWaterMark 0) and adds no buffer.
  let delivered = 0;
  const add = self.addEventListener.bind(self);
  self.addEventListener = (type, listener, options) => {
    if (type !== "fetch") return add(type, listener, options);
    return add(
      type,
      (event) => {
        const respondWith = event.respondWith.bind(event);
        Object.defineProperty(event, "respondWith", {
          value: (response) => respondWith(Promise.resolve(response).then(counted)),
        });
        listener(event);
      },
      options,
    );
  };
  function counted(response) {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else {
            delivered += value.byteLength;
            controller.enqueue(value);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }
  add("message", (event) => {
    if (event.data?.type === "delivered") event.ports[0].postMessage(delivered);
  });
}
importScripts("/dist/sw-worker.js");
