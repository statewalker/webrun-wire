// A Dedicated Worker serving HTTP and WebSockets through the ServiceWorker.
import { serveHttpInWorker } from "/dist/worker.js";
import { newHandler } from "./handler.js";

const name = new URL(self.location.href).searchParams.get("name") ?? "worker";
let service;
const { handler } = newHandler(name, {
  // Through the router, with no fetch event: `service.fetch`.
  up: async (_request, url) => {
    const target = url.searchParams.get("url");
    try {
      const response = await service.fetch(target);
      return new Response(`${name} via up: ${await response.text()}`);
    } catch (error) {
      return new Response(`${name} up failed: ${error.message}`, { status: 502 });
    }
  },
  // A socket from this worker to another handler, through the router.
  "ws-up": async (_request, url) => {
    const ws = new service.WebSocket(url.searchParams.get("url"));
    const reply = await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send("hello");
      ws.onmessage = (event) => resolve(event.data);
      ws.onerror = () => reject(new Error("socket failed"));
    });
    ws.close();
    return new Response(`${name} got ${reply}`);
  },
});
service = serveHttpInWorker(handler);

// Test commands straight from the page, so that no fetch event is involved.
self.addEventListener("message", async (event) => {
  const { cmd, url, n } = event.data ?? {};
  const reply = event.ports[0];
  if (!cmd || !reply) return;
  try {
    if (cmd === "up") {
      const response = await service.fetch(url);
      reply.postMessage({ ok: true, status: response.status, text: await response.text() });
    } else if (cmd === "read-up") {
      // Reads `n` chunks of a stream through the router, slowly, then stops.
      const reader = (await service.fetch(url)).body.getReader();
      let read = 0;
      for (let i = 0; i < n; i++) {
        const { value } = await reader.read();
        read += value.byteLength;
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 300));
      reply.postMessage({ ok: true, read: Math.round(read / 65536) });
      await reader.cancel();
    }
  } catch (error) {
    reply.postMessage({ ok: false, text: error.message });
  }
});
