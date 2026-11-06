import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { getPortCloseSignal, type MessageTarget, multiplexPort } from "@statewalker/webrun-rpc";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { connect, serve } from "../src/connect-serve.js";
import { PeerGoneError } from "../src/duplex-over-stream.js";
import { messageTargetOverStream } from "../src/message-target-over-stream.js";

const CHANNELS = 100;
/** Every channel must settle within this, once the peer is gone. */
const SETTLE_MS = 1000;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createNode(): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
  cleanups.push(() => node.stop());
  return node;
}

/** A server in this process: greets, drains its input, then stays open. */
async function localServer(): Promise<{ node: Libp2p; addr: Multiaddr }> {
  const node = await createNode();
  await serve({ node, maxInboundStreams: CHANNELS * 2 }, (input) =>
    (async function* () {
      yield new Uint8Array([1]);
      for await (const _ of input);
      await new Promise(() => {});
    })(),
  );
  const addr = node.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  return { node, addr };
}

/** The same server in a child process, so it can be SIGKILLed. */
async function forkedServer(): Promise<{ child: ChildProcess; addr: Multiaddr }> {
  const child = fork(fileURLToPath(new URL("./fixtures/greeting-server.ts", import.meta.url)), {
    execArgv: ["--import", "tsx"],
    stdio: "ignore",
  });
  cleanups.push(() => child.kill("SIGKILL"));
  const addr = await new Promise<string>((resolve, reject) => {
    child.once("message", (m) => resolve(String(m)));
    child.once("exit", (code) => reject(new Error(`server exited early: ${code}`)));
  });
  return { child, addr: multiaddr(addr) };
}

type Settled = "pending" | "done" | "error";

/**
 * Opens `CHANNELS` calls, reads each greeting, then leaves one `next()`
 * pending on each. `inputOpen` keeps the caller's input open (a tunnel), or
 * ends it at once (a request whose body was sent).
 */
async function openChannels(node: Libp2p, peer: Multiaddr, inputOpen: boolean) {
  const client = await connect({ node, peer, maxOutboundStreams: CHANNELS * 2 });
  const outcomes: Array<{ state: Settled; error?: unknown }> = [];
  for (let i = 0; i < CHANNELS; i++) {
    async function* input() {
      yield new Uint8Array([0]);
      if (inputOpen) await new Promise(() => {});
    }
    const out = client.call(input())[Symbol.asyncIterator]();
    expect((await out.next()).value).toEqual(new Uint8Array([1]));
    const outcome: { state: Settled; error?: unknown } = { state: "pending" };
    outcomes.push(outcome);
    out.next().then(
      (r) => {
        outcome.state = r.done ? "done" : "pending";
      },
      (error) => {
        outcome.state = "error";
        outcome.error = error;
      },
    );
  }
  return outcomes;
}

async function settle(outcomes: Array<{ state: Settled }>) {
  const deadline = Date.now() + SETTLE_MS;
  while (outcomes.some((o) => o.state === "pending") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const count = (state: Settled) => outcomes.filter((o) => o.state === state).length;
  return { error: count("error"), done: count("done"), pending: count("pending") };
}

describe("a dead peer fails every call, never ends it cleanly", () => {
  for (const inputOpen of [true, false]) {
    const mode = inputOpen ? "caller's input still open" : "caller's input already ended";

    it(`connection aborted in-process, ${mode}`, async () => {
      const server = await localServer();
      const clientNode = await createNode();
      const outcomes = await openChannels(clientNode, server.addr, inputOpen);
      for (const connection of server.node.getConnections()) {
        connection.abort(new Error("network dropped"));
      }
      expect(await settle(outcomes)).toEqual({ error: CHANNELS, done: 0, pending: 0 });
      const errors = outcomes.map((o) => (o as { error?: unknown }).error);
      expect(
        errors.every((e) => e instanceof PeerGoneError || (e as Error).name === "StreamResetError"),
      ).toBe(true);
    });

    it(`peer process SIGKILLed, ${mode}`, async () => {
      const { child, addr } = await forkedServer();
      const clientNode = await createNode();
      const outcomes = await openChannels(clientNode, addr, inputOpen);
      child.kill("SIGKILL");
      expect(await settle(outcomes)).toEqual({ error: CHANNELS, done: 0, pending: 0 });
      expect(outcomes.every((o) => (o as { error?: unknown }).error instanceof PeerGoneError)).toBe(
        true,
      );
      expect(clientNode.getConnections().flatMap((c) => c.streams)).toEqual([]);
    }, 20_000);
  }
});

it("a peer that ended its side, then died, fails a call still sending", async () => {
  // The tunnel case: the peer's output is complete, ours is still open.
  const node = await createNode();
  await serve({ node }, () =>
    (async function* () {
      yield new Uint8Array([1]);
    })(),
  );
  const addr = node.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const client = await connect({ node: await createNode(), peer: addr });
  async function* input() {
    yield new Uint8Array([0]);
    await new Promise(() => {});
  }
  const out = client.call(input())[Symbol.asyncIterator]();
  expect((await out.next()).value).toEqual(new Uint8Array([1]));
  const pending = out.next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const connection of node.getConnections()) connection.abort(new Error("network dropped"));
  const outcome = await Promise.race([
    pending.then(
      () => "settled",
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), SETTLE_MS)),
  ]);
  expect(outcome).toBeInstanceOf(PeerGoneError);
});

describe("a multiplexer over one libp2p stream closes with its connection", () => {
  it("SIGKILL: every port's close signal aborts and the table empties", async () => {
    const { child, addr } = await forkedServer();
    const clientNode = await createNode();
    const stream = await clientNode.dialProtocol(addr, ["/test-mux/1.0.0"]);
    const { target, signal } = messageTargetOverStream(stream);
    const mux = multiplexPort(target, { codec: msgpackCodec, side: "initiator", signal });

    const ports: MessageTarget[] = [];
    let hellos = 0;
    for (let i = 0; i < CHANNELS; i++) {
      const port = await mux.openPort({ kind: "test" });
      port.addEventListener("message", () => {
        hellos++;
      });
      ports.push(port);
    }
    const deadline = Date.now() + 5000;
    while (hellos < CHANNELS && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hellos).toBe(CHANNELS);

    const killedAt = Date.now();
    child.kill("SIGKILL");
    while (!signal.aborted && Date.now() - killedAt < SETTLE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(PeerGoneError);
    expect(ports.every((p) => getPortCloseSignal(p)?.aborted)).toBe(true);
    expect(mux.ports?.()).toEqual([]);
  }, 20_000);

  it("carries messages both ways, in order, across frame boundaries", async () => {
    const serverNode = await createNode();
    const received: unknown[] = [];
    await serverNode.handle("/test-echo/1.0.0", (stream) => {
      const { target } = messageTargetOverStream(stream);
      target.addEventListener("message", (event) => target.postMessage(event.data));
    });
    const addr = serverNode.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const clientNode = await createNode();
    const { target } = messageTargetOverStream(
      await clientNode.dialProtocol(addr, ["/test-echo/1.0.0"]),
    );
    target.addEventListener("message", (event) => received.push(event.data));
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const sent = [new Uint8Array([1, 2, 3]), big, new Uint8Array(0), new Uint8Array([9])];
    for (const message of sent) target.postMessage(message);
    const deadline = Date.now() + 5000;
    while (received.length < sent.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(received).toEqual(sent);
  });
});

describe("messageTargetOverStream reports when the stream is full", () => {
  /** Stands in for libp2p's `Stream`: the readiness fields and events only. */
  function fullStream() {
    const events = new EventTarget();
    const stream = Object.assign(events, {
      writableNeedsDrain: true,
      writeBufferLength: 70_000,
      send: () => false,
      close: async () => {},
      abort: () => {},
      async *[Symbol.asyncIterator]() {},
    });
    return stream;
  }

  it("whenDrained waits for the stream's drain, and bufferedAmount is its write buffer", async () => {
    const stream = fullStream();
    const { target } = messageTargetOverStream(stream as never);
    expect(target.bufferedAmount).toBe(70_000);
    let drained = false;
    const waiting = target.whenDrained().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(false);
    stream.writableNeedsDrain = false;
    stream.dispatchEvent(new Event("drain"));
    await waiting;
    expect(drained).toBe(true);
    await expect(target.whenDrained()).resolves.toBeUndefined();
  });

  it("whenDrained settles when the stream closes instead, so no sender hangs", async () => {
    const stream = fullStream();
    const { target } = messageTargetOverStream(stream as never);
    const waiting = target.whenDrained();
    stream.dispatchEvent(new Event("close"));
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("review fixes (#44)", () => {
  it("a message the peer sent just before closing is delivered before signal aborts", async () => {
    const serverNode = await createNode();
    await serverNode.handle("/test-last/1.0.0", (stream) => {
      const { target } = messageTargetOverStream(stream);
      target.addEventListener("message", async () => {
        target.postMessage(new Uint8Array([42]));
        await target.close();
      });
    });
    const addr = serverNode.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const clientNode = await createNode();
    let late = 0;
    for (let i = 0; i < 10; i++) {
      const { target, signal } = messageTargetOverStream(
        await clientNode.dialProtocol(addr, ["/test-last/1.0.0"]),
      );
      const outcome = await new Promise<string>((resolve) => {
        target.addEventListener("message", () => resolve(signal.aborted ? "late" : "ok"));
        signal.addEventListener("abort", () => setTimeout(() => resolve("never"), 100));
        target.postMessage(new Uint8Array([1]));
      });
      if (outcome !== "ok") late++;
    }
    expect(late).toBe(0);
  });

  it("a caller that cancels a response it no longer wants is not logged as a dead peer", async () => {
    const serverNode = await createNode();
    let finished = 0;
    await serve({ node: serverNode }, (input) =>
      (async function* () {
        try {
          for await (const _ of input);
          for (;;) {
            yield new Uint8Array([1]);
            await new Promise((r) => setTimeout(r, 10));
          }
        } finally {
          finished++;
        }
      })(),
    );
    const addr = serverNode.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const client = await connect({ node: await createNode(), peer: addr });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      for (let i = 0; i < 3; i++) {
        const out = client.call([new Uint8Array([0])])[Symbol.asyncIterator]();
        await out.next();
        await out.return?.(undefined);
      }
      const deadline = Date.now() + 2000;
      while (finished < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    } finally {
      console.warn = warn;
    }
    expect(finished).toBe(3);
    expect(warnings.filter((w) => w.includes("went away"))).toEqual([]);
  });

  it("a malformed length or one past maxMessageBytes aborts the stream instead of buffering", async () => {
    const serverNode = await createNode();
    const signals: AbortSignal[] = [];
    await serverNode.handle("/test-bad/1.0.0", (stream) => {
      const { signal } = messageTargetOverStream(stream, { maxMessageBytes: 1024 });
      signals.push(signal);
    });
    const addr = serverNode.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const clientNode = await createNode();
    const bad = await clientNode.dialProtocol(addr, ["/test-bad/1.0.0"]);
    bad.send(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])); // a varint that never ends
    const big = await clientNode.dialProtocol(addr, ["/test-bad/1.0.0"]);
    big.send(new Uint8Array([0x80, 0x80, 0x04])); // claims 64 KiB, over the 1 KiB cap
    const deadline = Date.now() + 2000;
    while ((signals.length < 2 || !signals.every((s) => s.aborted)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
  });
});
