// The page: one multiplexer over the MessagePort the content script hands over.
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { callBidi, duplexOverPort, methodsClient, multiplexPort } from "@statewalker/webrun-rpc";
import { messagePortPipe } from "../../../src/index.ts";

const METHODS = ["add", "echo", "sleep", "stats"];
let connection;

function requestPort() {
  return new Promise((resolve) => {
    const id = Math.random();
    const onMessage = (event) => {
      if (
        event.source !== window ||
        event.data?.type !== "webrun-connected" ||
        event.data.id !== id
      )
        return;
      window.removeEventListener("message", onMessage);
      resolve(event.ports[0]);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ type: "webrun-connect", id }, "*");
  });
}

async function connect() {
  const pipe = messagePortPipe(await requestPort(), {
    name: "page<->cs",
    maxMessageSize: 256 * 1024,
  });
  const mux = multiplexPort(pipe.target, {
    codec: msgpackCodec,
    side: "initiator",
    window: "auto",
    signal: pipe.signal,
    maxMessageSize: pipe.maxMessageSize,
  });
  const methods = methodsClient(await mux.openPort({ kind: "methods" }), {
    channelName: "methods",
    methods: METHODS,
  });
  const call = (input) =>
    (async function* () {
      const port = await mux.openPort({ kind: "stream" });
      yield* duplexOverPort(port, { maxMessageSize: mux.maxMessageSize })(input);
    })();
  connection = { pipe, mux, methods, call };
  return connection;
}

const pattern = (offset, n) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (offset + i) & 0xff;
  return bytes;
};

window.webrunTest = {
  async requestResponse() {
    const { methods } = await connect();
    const nested = { text: "héllo ✓", list: [1, { deep: true }] };
    return {
      sum: await methods.add(2, 3),
      echoed: JSON.stringify(await methods.echo(nested)) === JSON.stringify(nested),
      parallel: (await Promise.all(Array.from({ length: 100 }, (_, i) => methods.add(i, 1)))).every(
        (v, i) => v === i + 1,
      ),
    };
  },
  async eventsBreak() {
    const { mux, methods } = await connect();
    const ticks = [];
    const port = await mux.openPort({ kind: "events" });
    for await (const event of callBidi(port, [], {
      intervalMs: 10,
      options: { closePort: true },
    })) {
      ticks.push(event.tick);
      if (ticks.length === 5) break;
    }
    let stats = await methods.stats();
    for (let i = 0; i < 50 && stats.eventsOpen !== 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      stats = await methods.stats();
    }
    return { ticks, stats, ports: mux.ports().length };
  },
  async streamedFetch(size) {
    const { call } = await connect();
    const started = performance.now();
    const response = await fetchOverDuplex(
      call,
      new Request(`https://ext.invalid/gen?size=${size}`),
    );
    const body = new Uint8Array(await response.arrayBuffer());
    let ok = body.length === size;
    for (let i = 0; ok && i < body.length; i++) ok = body[i] === (i & 0xff);
    const downloadMs = performance.now() - started;

    const upload = pattern(7, size);
    const echoStarted = performance.now();
    const echoed = new Uint8Array(
      await (
        await fetchOverDuplex(
          call,
          new Request("https://ext.invalid/echo", {
            method: "POST",
            body: new Blob([upload]).stream(),
            duplex: "half",
          }),
        )
      ).arrayBuffer(),
    );
    let echoOk = echoed.length === size;
    for (let i = 0; echoOk && i < size; i++) echoOk = echoed[i] === upload[i];
    return { ok, echoOk, downloadMs, echoMs: performance.now() - echoStarted };
  },
  async startPending() {
    const { mux, methods, call } = await connect();
    const outcome = {};
    const settle = (name, promise) =>
      promise.then(
        () => {
          outcome[name] = "resolved";
        },
        (error) => {
          outcome[name] = String(error?.message ?? error);
        },
      );
    settle("call", methods.sleep(60_000));
    settle(
      "events",
      (async () => {
        for await (const _ of callBidi(await mux.openPort({ kind: "events" }), [], {
          intervalMs: 50,
        })) {
          /* runs until the worker stops */
        }
      })(),
    );
    settle(
      "download",
      fetchOverDuplex(call, new Request("https://ext.invalid/gen?size=209715200")).then((r) =>
        r.arrayBuffer(),
      ),
    );
    window.webrunPending = outcome;
    return true;
  },
  pendingOutcome() {
    return {
      ...window.webrunPending,
      pipeReason: connection.pipe.signal.aborted
        ? String(connection.pipe.signal.reason?.message)
        : null,
    };
  },
  async afterStop() {
    let deadCall;
    try {
      await connection.methods.add(1, 1);
      deadCall = "resolved";
    } catch (error) {
      deadCall = String(error?.message ?? error);
    }
    const started = performance.now();
    const { methods } = await connect();
    const sum = await methods.add(20, 22);
    return { deadCall, reconnectSum: sum, reconnectMs: performance.now() - started };
  },
};
window.postMessage({ type: "webrun-page-ready" }, "*");
