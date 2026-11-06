// Server side for all modes. One node, two protocols:
//   PROTO_A: webrun-streams-libp2p serve (one libp2p stream per channel)
//   PROTO_B: one libp2p stream per connection -> streamPort -> multiplexPort,
//            either webrun-rpc serve (mode B2, duplexOverPort per port) or raw
//            virtual ports (mode B1, app uses postMessage directly).

import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  getPortCloseSignal,
  multiplexPort,
  overPipe,
  serve as rpcServe,
  whenPortReady,
} from "@statewalker/webrun-rpc";
import { serveConnections } from "@statewalker/webrun-streams-libp2p";
import { ACK, createNode, PROTO_A, PROTO_B, td, tick } from "./common.mjs";
import { adapterStats, streamPort } from "./stream-port.mjs";

export const stats = {
  openChannels: 0,
  bulkProduced: 0,
  floodBytes: 0,
  floodMsgs: 0,
  bStreams: 0,
  errors: [],
};

function noteErr(e) {
  if (stats.errors.length < 20) stats.errors.push(String(e?.message ?? e).slice(0, 300));
}

// Duplex handler shared by A and B2. First chunk = JSON command.
const duplexHandler = (input) =>
  (async function* () {
    const it = input[Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) return;
    const cmd = JSON.parse(td.decode(first.value));
    stats.openChannels++;
    try {
      yield ACK;
      if (cmd.k === "echo") {
        for (;;) {
          const n = await it.next();
          if (n.done) return;
          yield n.value;
        }
      } else if (cmd.k === "bulk") {
        let stop = false;
        (async () => {
          try {
            for (;;) {
              const n = await it.next();
              if (n.done) break;
            }
          } catch {}
          stop = true;
        })();
        const chunk = new Uint8Array(cmd.size).fill(7);
        let sent = 0;
        while (!stop && sent < cmd.total) {
          yield chunk;
          sent += cmd.size;
          stats.bulkProduced += cmd.size;
        }
      } else if (cmd.k === "flood") {
        for (;;) {
          const n = await it.next();
          if (n.done) return;
          stats.floodBytes += n.value.byteLength;
          stats.floodMsgs++;
        }
      } else {
        // idle: hold the channel open even after the client ends its input,
        // until the transport tears the stream down.
        for (;;) {
          const n = await it.next();
          if (n.done) break;
        }
        await new Promise(() => {});
      }
    } finally {
      stats.openChannels--;
    }
  })();

// Raw virtual-port handler (B1): the app talks postMessage directly.
function rawOnPort(port, credit = false) {
  let cmd = null;
  let stop = false;
  const closedSig = getPortCloseSignal(port);
  stats.openChannels++;
  closedSig?.addEventListener(
    "abort",
    () => {
      stats.openChannels--;
      stop = true;
    },
    { once: true },
  );
  port.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!cmd) {
      cmd = JSON.parse(td.decode(d));
      port.postMessage(ACK);
      if (cmd.k === "bulk") void bulk();
      return;
    }
    if (cmd.k === "echo") port.postMessage(d);
    else if (cmd.k === "flood") {
      stats.floodBytes += d.byteLength;
      stats.floodMsgs++;
    } else if (cmd.k === "bulk") stop = true; // any message = stop
  });
  async function bulk() {
    const chunk = new Uint8Array(cmd.size).fill(7);
    let sent = 0;
    // No backpressure signal exists on a virtual port; yield to the event loop
    // between chunks (as a well-behaved app without bufferedAmount would).
    while (!stop && sent < cmd.total) {
      port.postMessage(chunk);
      sent += cmd.size;
      stats.bulkProduced += cmd.size;
      // B3 waits for room in the port's window; B1 has no signal and yields a tick.
      if (credit) await whenPortReady(port);
      else await tick();
    }
  }
  return true;
}

export async function startServer(cfg = {}) {
  const node = await createNode(cfg);
  // A: identical to httpeers' usage of serveConnections, limits configurable.
  await serveConnections(
    { node, protocol: PROTO_A, maxInboundStreams: cfg.aMaxIn, maxOutboundStreams: cfg.aMaxOut },
    () => duplexHandler,
  );
  // B: one stream per connection, mux on top.
  await node.handle(
    PROTO_B,
    (stream) => {
      stats.bStreams++;
      let teardown = null;
      const port = streamPort(stream, {
        onClose: () => {
          if (cfg.wire !== false) void teardown?.();
        },
      });
      const mo = { codec: msgpackCodec, side: "responder", maxPorts: cfg.maxPorts };
      if (cfg.bRaw) {
        // The window comes with each port's open (B3); the responder applies it.
        const credit = cfg.mode === "B3";
        const mux = multiplexPort(port, { ...mo, onPort: (p) => rawOnPort(p, credit) });
        teardown = () => mux.close();
      } else {
        void rpcServe({ mux: overPipe(port, mo) }, duplexHandler).then((t) => {
          teardown = t;
        }, noteErr);
      }
    },
    { maxInboundStreams: 4 },
  );
  return {
    node,
    addr: node.getMultiaddrs()[0].toString(),
    stats: () => ({ ...stats, adapter: { ...adapterStats } }),
    killConnections: () => {
      for (const c of node.getConnections()) c.abort(new Error("killed by benchmark"));
    },
    stop: () => node.stop(),
  };
}
