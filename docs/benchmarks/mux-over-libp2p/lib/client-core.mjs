// Client side: a uniform "channel" API over the three modes.
//   A  : webrun-streams-libp2p connect -> one libp2p stream per channel
//   B2 : webrun-rpc connect(overPipe(streamPort(one libp2p stream))) -> duplexOverPort per virtual port
//   B1 : multiplexPort(streamPort(one libp2p stream)) raw virtual ports, app uses postMessage
//   B3 : as B1 with the per-port window (prototype): a message is consumed when next() takes
//        it (the listener's promise settles then), and senders wait for whenPortReady
// Channel: { ready: Promise (ack received), send(bytes), next(): Promise<{done,value}>,
//            stats: {inboxBytes, maxInboxBytes}, cancel() }
import { multiaddr } from "@multiformats/multiaddr";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  getPortCloseSignal,
  multiplexPort,
  overPipe,
  connect as rpcConnect,
  whenPortReady,
} from "@statewalker/webrun-rpc";
import { connect as p2pConnect } from "@statewalker/webrun-streams-libp2p";
import { createNode, PROTO_A, PROTO_B, te } from "./common.mjs";
import { streamPort } from "./stream-port.mjs";

// A push-driven async input source (for echo / idle / bulk control).
function inputQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(v) {
      items.push(v);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    // A hand-written iterator (not an async generator) so that return() settles
    // a pending next() at once — an async generator parked on an await would
    // queue return() forever, which hangs duplexOverPort's cancel path.
    iter() {
      let pendingResolve = null;
      const it = {
        [Symbol.asyncIterator]() {
          return it;
        },
        async next() {
          for (;;) {
            if (items.length) return { done: false, value: items.shift() };
            if (ended) return { done: true, value: undefined };
            const r = await new Promise((res) => {
              pendingResolve = res;
              wake = () => res("wake");
            });
            wake = null;
            pendingResolve = null;
            if (r === "ret") return { done: true, value: undefined };
          }
        },
        async return() {
          ended = true;
          pendingResolve?.("ret");
          return { done: true, value: undefined };
        },
      };
      return it;
    },
  };
}

function duplexChannel(call, cmd, customInput) {
  const q = inputQueue();
  const cmdBytes = te.encode(JSON.stringify(cmd));
  let input;
  if (customInput) {
    input = (async function* () {
      yield cmdBytes;
      yield* customInput;
    })();
  } else {
    q.push(cmdBytes);
    input = q.iter();
  }
  const out = call(input)[Symbol.asyncIterator]();
  const ch = {
    send: (b) => q.push(b),
    end: () => q.end(),
    next: () => out.next(),
    cancel: () => out.return(undefined),
    stats: { inboxBytes: 0, maxInboxBytes: 0 },
  };
  ch.ready = out.next().then((r) => {
    if (r.done) throw new Error("channel ended before ack");
  });
  return ch;
}

function rawChannel(mux, cmd, credit = false) {
  const inbox = [];
  const consumed = []; // B3: resolves each message's listener promise when next() takes it
  const waiters = [];
  const stats = { inboxBytes: 0, maxInboxBytes: 0 };
  let err = null;
  let port;
  const settle = () => {
    while (waiters.length && (inbox.length || err)) {
      const w = waiters.shift();
      if (inbox.length) {
        const v = inbox.shift();
        consumed.shift()?.();
        stats.inboxBytes -= v.byteLength;
        w.res({ done: false, value: v });
      } else w.rej(err);
    }
  };
  const opened = mux.openPort().then((p) => {
    port = p;
    getPortCloseSignal(p)?.addEventListener(
      "abort",
      (_e) => {
        err = (p && getPortCloseSignal(p).reason) || new Error("port closed");
        settle();
      },
      { once: true },
    );
    p.addEventListener("message", (ev) => {
      inbox.push(ev.data);
      const taken = credit ? new Promise((r) => consumed.push(r)) : undefined;
      stats.inboxBytes += ev.data.byteLength;
      if (stats.inboxBytes > stats.maxInboxBytes) stats.maxInboxBytes = stats.inboxBytes;
      settle();
      return taken;
    });
    p.postMessage(te.encode(JSON.stringify(cmd)));
  });
  const ch = {
    stats,
    get port() {
      return port;
    },
    send: (b) => port.postMessage(b),
    // B3: wait until the port's queue is empty; B1 has no signal and yields a tick.
    room: credit ? () => whenPortReady(port) : undefined,
    end: () => port.close(),
    next: () =>
      new Promise((res, rej) => {
        waiters.push({ res, rej });
        settle();
      }),
    cancel: async () => {
      try {
        port.postMessage(new Uint8Array([0]));
      } catch {}
      port.close();
    },
  };
  ch.ready = opened.then(() => ch.next()).then(() => {});
  return ch;
}

export async function makeClient(addrStr, mode, cfg = {}) {
  const node = await createNode(cfg);
  const peer = multiaddr(addrStr);
  if (mode === "A") {
    const c = await p2pConnect({ node, peer, protocol: PROTO_A, maxOutboundStreams: cfg.aMaxOut });
    return {
      node,
      open: (cmd, input) => duplexChannel(c.call, cmd, input),
      close: () => c.close(),
    };
  }
  // B: a single libp2p stream carries everything.
  const stream = await node.dialProtocol(peer, PROTO_B);
  let onDead = null;
  const port = streamPort(stream, {
    onClose: () => {
      if (cfg.wire !== false) void onDead?.();
    },
  });
  const mo = { codec: msgpackCodec, side: "initiator", maxPorts: cfg.maxPorts };
  if (mode === "B2") {
    const c = await rpcConnect({ mux: overPipe(port, mo) });
    onDead = () => c.close();
    return {
      node,
      port,
      open: (cmd, input) => duplexChannel(c.call, cmd, input),
      close: () => c.close(),
    };
  }
  const credit = mode === "B3";
  const mux = multiplexPort(port, credit ? { ...mo, window: cfg.window ?? 256 * 1024 } : mo);
  onDead = () => mux.close();
  return {
    node,
    port,
    open: (cmd) => rawChannel(mux, cmd, credit),
    close: () => mux.close(),
    raw: true,
  };
}
