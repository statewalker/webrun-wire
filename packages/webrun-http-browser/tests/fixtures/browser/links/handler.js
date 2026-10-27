// One handler, used both in the page (`register`) and in workers
// (`serveHttpInWorker`), so every scenario can run on either side.
import { isWebSocketUpgrade, requestedProtocols, upgradeWebSocket } from "/dist/worker.js";

export function newHandler(name, extra = {}) {
  const stats = { produced: 0, cancelled: 0, finished: 0, bodies: [] };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function handler(request) {
    const url = new URL(request.url);
    const [, route = ""] = url.pathname.match(/\/(?:links\/[^/]+|~[^/]+|svc)\/(.*)$/) ?? [];
    if (isWebSocketUpgrade(request)) {
      if (route === "ws-refuse") return new Response(null, { status: 404 });
      const protocol = requestedProtocols(request)[0] ?? "";
      const { socket, response } = upgradeWebSocket(request, { protocol });
      socket.accept();
      socket.addEventListener("message", (event) => {
        socket.send(typeof event.data === "string" ? `${name}:${event.data}` : event.data);
      });
      return response;
    }
    switch (route) {
      case "who":
        return new Response(name);
      case "slow": {
        await sleep(Number(url.searchParams.get("ms") ?? 1500));
        return new Response(`${name}:slow`);
      }
      case "stats":
        return Response.json(stats);
      case "stream": {
        // An endless stream of 64 KiB chunks, counted as they are produced.
        const chunk = new Uint8Array(65536);
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                stats.produced++;
                controller.enqueue(chunk.slice());
              },
              cancel() {
                stats.cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
        );
      }
      case "sse": {
        const encoder = new TextEncoder();
        let i = 0;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (i > 0) await sleep(300);
              if (i === 3) {
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(`data: ${i++}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      case "echo-body": {
        let bytes = 0;
        let chunks = 0;
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          chunks++;
        }
        return Response.json({ bytes, chunks });
      }
      default:
        if (extra[route]) return await extra[route](request, url);
        return new Response(`${name}: no route ${route}`, { status: 404 });
    }
  }
  return { handler, stats };
}
