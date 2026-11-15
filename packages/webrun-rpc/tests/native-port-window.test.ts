import { deserialize, serialize } from "node:v8";
import {
  type Duplex,
  type NativeChannel,
  type NativePortMuxControl,
  newMessagePipe,
  newNativePortMux,
  type ValueCodec,
} from "@statewalker/webrun-streams";
import { describeDuplexAdapter, type MakePair } from "@statewalker/webrun-streams-conformance";
import { afterEach, describe, expect, it } from "vitest";
import { connect, overPorts, portBufferedAmount, serve } from "../src/index.js";

// Native ports with a window (statewalker/webrun-wire#153): the stream tier
// pipelines its chunks on a port whose flow both ends agreed, as it does on a
// windowed virtual port, and holds a producer to the window instead of one
// confirmed chunk per round trip.

const KiB = 1024;
const WINDOW = 64 * KiB;
const MAX_MESSAGE = 16 * KiB;

/** Bytes, as the native transports carry them. */
const v8Codec: ValueCodec = {
  encode: (value) => new Uint8Array(serialize(value)),
  decode: (bytes) => deserialize(bytes),
};

/** Two byte pipes wired to each other, delivering on a later task, in order. */
function channelPair(): [NativeChannel, NativeChannel] {
  let a!: ReturnType<typeof newMessagePipe>;
  let b!: ReturnType<typeof newMessagePipe>;
  const link = (peer: () => ReturnType<typeof newMessagePipe>) =>
    newMessagePipe(
      {
        send: (bytes) => {
          const copy = bytes.slice();
          setTimeout(() => peer().deliver(copy), 0);
        },
        close: () => {
          setTimeout(() => peer().end(new Error("memory: the peer closed the channel")), 0);
        },
      },
      { name: "memory" },
    );
  a = link(() => b);
  b = link(() => a);
  return [{ pipe: a.pipe.target }, { pipe: b.pipe.target }];
}

interface Windows {
  opener?: number;
  server?: number;
}

/** A memory transport for native ports: the opener asks, the serving end answers (WebRTC's way). */
function memoryTransport(windows: Windows, codec: ValueCodec = v8Codec) {
  let server: NativePortMuxControl | undefined;
  const both = windows.opener !== undefined && windows.server !== undefined;
  const opener = () =>
    newNativePortMux({
      name: "memory",
      codec,
      maxMessageSize: MAX_MESSAGE,
      window: windows.opener,
      open: async () => {
        const [near, far] = channelPair();
        const target = server;
        setTimeout(() => {
          if (target) target.accept({ ...far, window: both ? "agreed" : undefined }, {});
          else void far.pipe.close();
        }, 0);
        return { ...near, window: windows.opener !== undefined ? "offered" : undefined };
      },
    }).mux;
  const serving = (onPort: (port: never) => boolean | undefined) => {
    server = newNativePortMux({
      name: "memory",
      codec,
      maxMessageSize: MAX_MESSAGE,
      window: windows.server,
      onPort: onPort as never,
      open: async () => {
        throw new Error("memory: the serving end opens no ports here");
      },
    });
    return server.mux;
  };
  return { opener, serving };
}

const echo: Duplex = async function* (input) {
  for await (const chunk of input) yield chunk;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** `connect` / `serve` over the memory transport; `kinds` counts the stream tier's messages by type. */
async function link(windows: Windows, handler: Duplex = echo) {
  const kinds = new Map<string, number>();
  const counting: ValueCodec = {
    encode: v8Codec.encode,
    decode: (bytes) => {
      const value = v8Codec.decode(bytes) as { type?: string } | undefined;
      const type = String(value?.type);
      kinds.set(type, (kinds.get(type) ?? 0) + 1);
      return value;
    },
  };
  const t = memoryTransport(windows, counting);
  const teardown = await serve(
    { mux: overPorts(async (onPort) => t.serving(onPort as never) as never) },
    handler,
  );
  const { call, close } = await connect({ mux: overPorts(async () => t.opener() as never) });
  cleanups.push(async () => {
    await close();
    await teardown();
  });
  return { call, kinds };
}

function body(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31) & 0xff;
  return out;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

describe("native ports with a window: the stream tier", () => {
  it("pipelines chunks once both ends agreed the window, and every byte arrives", async () => {
    const { call, kinds } = await link({ opener: WINDOW, server: WINDOW });
    const sent = body(1024 * KiB);
    const got = await collect(call([sent]));
    expect(got).toEqual(sent);
    // 64 chunks each way: nearly all pipelined, a confirmed call at most
    // while the opener waits for the serving end's hello.
    expect(kinds.get("webrun-rpc:chunk") ?? 0).toBeGreaterThan(100);
    expect(kinds.get("request") ?? 0).toBeLessThanOrEqual(4);
  });

  it("an opener with a window and a serving end without: each chunk is confirmed, as before", async () => {
    const { call, kinds } = await link({ opener: WINDOW });
    const sent = body(256 * KiB);
    const got = await collect(call([sent]));
    expect(got).toEqual(sent);
    expect(kinds.get("webrun-rpc:chunk") ?? 0).toBe(0);
    expect(kinds.get("request") ?? 0).toBeGreaterThan(16);
  });

  it("portBufferedAmount and the producer's wait follow a native port's window", async () => {
    const t = memoryTransport({ opener: 4 * KiB, server: 4 * KiB });
    const inbound: never[] = [];
    const server = t.serving((port) => {
      inbound.push(port);
      return true;
    });
    const mux = t.opener();
    cleanups.push(async () => {
      await mux.close();
      await server.close();
    });
    const port = await mux.openPort();
    port.postMessage("hello");
    const deadline = Date.now() + 2000;
    while (inbound.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    const far = inbound[0] as unknown as EventTarget & {
      addEventListener(type: "message", l: (e: MessageEvent) => unknown): void;
    };
    // Never consumed: credit never comes back.
    far.addEventListener("message", () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 8; i++) port.postMessage(body(1024));
    expect(portBufferedAmount(port as never)).toBeGreaterThan(0);
  });
});

/** The conformance suite over windowed native ports: L6 holds a producer to the window. */
const makeWindowedPair: MakePair = async () => {
  const t = memoryTransport({ opener: WINDOW, server: WINDOW });
  return {
    // The window, one chunk queued in the sender's port and one in the consumer's hands.
    runAheadBytes: WINDOW + 2 * MAX_MESSAGE,
    async connect() {
      return connect({ mux: overPorts(async () => t.opener() as never) });
    },
    async serve(handler) {
      return serve(
        { mux: overPorts(async (onPort) => t.serving(onPort as never) as never) },
        handler,
      );
    },
    async close() {},
  };
};

describeDuplexAdapter("native ports with a window (in memory)", makeWindowedPair);
