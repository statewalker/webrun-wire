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
