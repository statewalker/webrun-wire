// The extension's service worker: a broker serving methods, an event stream
// and fetch over one multiplexer per chrome.runtime.Port.
import { serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  listenBidi,
  multiplexPort,
  serveDuplexOverPort,
  serveMethods,
} from "@statewalker/webrun-rpc";
import { chromePortPipe } from "../../../src/index.ts";

const stats = { eventsOpen: 0, eventsFinally: 0, connections: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const METHODS = ["add", "echo", "sleep", "stats"];
const methods = {
  add: (a, b) => a + b,
  echo: (value) => value,
  sleep: async (ms) => {
    await sleep(ms);
    return `slept ${ms}`;
  },
  stats: () => ({ ...stats }),
};

async function* ticks(_input, params) {
  stats.eventsOpen++;
  try {
    for (let tick = 0; ; tick++) {
      await sleep(params.intervalMs ?? 10);
      yield { tick };
    }
  } finally {
    stats.eventsOpen--;
    stats.eventsFinally++;
  }
}

const fetchHandler = serveFetchOverDuplex(async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/echo") return new Response(request.body);
  // /gen?size=N: N bytes generated here, 64 KiB at a time.
  const size = Number(url.searchParams.get("size") ?? 0);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const n = Math.min(64 * 1024, size - sent);
      const chunk = new Uint8Array(n);
      for (let i = 0; i < n; i++) chunk[i] = (sent + i) & 0xff;
      sent += n;
      controller.enqueue(chunk);
    },
  });
  return new Response(body, { headers: { "content-length": String(size) } });
});

chrome.runtime.onConnect.addListener((port) => {
  stats.connections++;
  const pipe = chromePortPipe(port, { name: "sw<->cs" });
  multiplexPort(pipe.target, {
    codec: msgpackCodec,
    side: "responder",
    window: "auto",
    signal: pipe.signal,
    maxMessageSize: pipe.maxMessageSize,
    onPort: (p, meta) => {
      if (meta?.kind === "methods")
        serveMethods(p, methods, { channelName: "methods", methods: METHODS });
      else if (meta?.kind === "events") listenBidi(p, ticks);
      else if (meta?.kind === "stream") serveDuplexOverPort(p, fetchHandler);
    },
  });
});
