import { deserialize, serialize } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import * as v014 from "webrun-rpc-0-14";
import type {
  MessageTarget,
  PortCodec,
  PortEnvelope,
  PortInfo,
  PortMuxOptions,
  PortWindow,
} from "../src/index.js";
import * as current from "../src/index.js";
import { estimateMessageSize } from "../src/multiplex-port.js";

// #188: a port's window adapts after the ack. The receiving end of each
// direction grants a larger window while the port is limited by its window
// and the round trip stays near its minimum, a smaller one when the round trip
// inflates, never more than its ceiling, and announces it in its credits
// (`{ type: "credit", id, bytes, window }`). A peer of 0.14 ignores the field.
//
// The pipe here delays every message by a set time (`delayedPipe`), so the
// round trip is known and can be changed mid-flow.

type Kit = Pick<
  typeof current,
  "multiplexPort" | "structuredCodec" | "whenPortReady" | "portBufferedAmount"
>;
const NEW = current as Kit;
const OLD = v014 as unknown as Kit;
type Mux = ReturnType<Kit["multiplexPort"]>;

const KiB = 1024;
const MiB = 1024 * KiB;
const CHUNK = 4 * KiB;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A byte codec that counts exact sizes and can frame: Node's structured serializer. */
const v8Codec: PortCodec = {
  post: (port, envelope) => port.postMessage(v8Codec.encode?.(envelope)),
  read: (event) => v8Codec.decode?.(event.data),
  encode: (envelope) => new Uint8Array(serialize(envelope)),
  decode: (data) => {
    if (!(data instanceof Uint8Array)) return undefined;
    const value = deserialize(data) as PortEnvelope;
    return typeof value?.id === "number" && typeof value.type === "string" ? value : undefined;
  },
  halfClose: true,
};

/** An envelope from what crossed the pipe, whichever codec placed it. */
function envelopeOf(data: unknown): PortEnvelope | undefined {
  if (data instanceof Uint8Array) {
    try {
      return v8Codec.decode?.(data);
    } catch {
      return undefined;
    }
  }
  return data as PortEnvelope;
}

/**
 * Two ends of a pipe that delays each message by `delay.ms`, in order.
 * Everything but messages and frames is logged as it is posted.
 */
function delayedPipe(delay: { ms: number }) {
  type Listener = (event: MessageEvent) => unknown;
  interface Side {
    listeners: Set<Listener>;
    queue: { due: number; data: unknown }[];
    timer?: ReturnType<typeof setTimeout>;
  }
  const A: Side = { listeners: new Set(), queue: [] };
  const B: Side = { listeners: new Set(), queue: [] };
  const wire: { from: "a" | "b"; envelope: PortEnvelope }[] = [];
  let closed = false;
  const deliver = (to: Side) => {
    to.timer = undefined;
    const now = performance.now();
    while (!closed && to.queue.length && (to.queue[0]?.due ?? 0) <= now + 0.5) {
      const { data } = to.queue.shift() as { data: unknown };
      for (const listener of [...to.listeners]) listener({ data } as MessageEvent);
    }
    schedule(to);
  };
  const schedule = (to: Side) => {
    if (to.timer || !to.queue.length || closed) return;
    to.timer = setTimeout(
      () => deliver(to),
      Math.max(0, (to.queue[0]?.due ?? 0) - performance.now()),
    );
  };
  const end = (self: Side, peer: Side, from: "a" | "b"): MessageTarget => ({
    postMessage(message: unknown) {
      if (closed) return;
      const data = structuredClone(message);
      const envelope = envelopeOf(data);
      if (envelope && envelope.type !== "message" && envelope.type !== "frame") {
        wire.push({ from, envelope });
      }
      const last = peer.queue.at(-1)?.due ?? 0;
      peer.queue.push({ due: Math.max(performance.now() + delay.ms, last), data });
      schedule(peer);
    },
    addEventListener: (_type, listener) => self.listeners.add(listener as Listener),
    removeEventListener: (_type, listener) => self.listeners.delete(listener as Listener),
  });
  cleanups.push(() => {
    closed = true;
    clearTimeout(A.timer);
    clearTimeout(B.timer);
  });
  return { a: end(A, B, "a"), b: end(B, A, "b"), wire };
}

interface End {
  kit: Kit;
  window?: PortWindow;
  codec?: PortCodec;
  frameSize?: number;
}

/**
 * An opener's mux on `a`, a responder's on `b`. Ports the responder accepts
 * land in `inbound`, and what arrives on them is counted from the start in
 * `received` (`listener` is the reader: what its promise holds stays unconsumed).
 */
function setup(
  opener: End,
  responder: End,
  delay = { ms: 5 },
  listener?: (e: MessageEvent) => unknown,
) {
  const pipe = delayedPipe(delay);
  const inbound: MessageTarget[] = [];
  const received: Count[] = [];
  const server = responder.kit.multiplexPort(pipe.b, {
    codec: responder.codec ?? responder.kit.structuredCodec,
    side: "responder",
    window: responder.window,
    frameSize: responder.frameSize,
    onPort: (port: MessageTarget) => {
      inbound.push(port);
      received.push(consume(port, listener));
      return true;
    },
  } as PortMuxOptions) as Mux;
  const client = opener.kit.multiplexPort(pipe.a, {
    codec: opener.codec ?? opener.kit.structuredCodec,
    side: "initiator",
    window: opener.window,
    frameSize: opener.frameSize,
  } as PortMuxOptions) as Mux;
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { ...pipe, client, server, inbound, received, delay };
}

/** Posts `total` bytes in chunks, holding back while the port queues more than two chunks. */
async function produce(
  kit: Kit,
  port: MessageTarget,
  total: number,
  stop: () => boolean = () => false,
): Promise<number> {
  let sent = 0;
  for (let i = 0; sent < total && !stop(); i++) {
    port.postMessage(new Uint8Array(CHUNK).fill(i & 0xff));
    sent += CHUNK;
    // Always a later task: before the ack nothing is held back yet.
    await kit.whenPortReady(port, 2 * CHUNK);
  }
  return sent;
}

interface Count {
  bytes: number;
  chunks: number;
  outOfOrder: number;
}

/** Counts the bytes that arrive on `port` and checks they came in order. */
function consume(port: MessageTarget, listener?: (e: MessageEvent) => unknown): Count {
  const state = { bytes: 0, chunks: 0, outOfOrder: 0 };
  port.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as Uint8Array;
    if (data[0] !== (state.chunks & 0xff)) state.outOfOrder++;
    state.chunks++;
    state.bytes += data.byteLength;
    return listener?.(e) as undefined;
  });
  return state;
}

/**
 * Opens a port and waits until both ends hold to its window (the ack and its
 * answer have crossed): before that, nothing is held back at all.
 */
async function openAgreed(t: { client: Mux; server: Mux }): Promise<MessageTarget> {
  const port = await t.client.openPort();
  await waitFor(
    () => t.client.ports()[0]?.window !== undefined && t.server.ports()[0]?.window !== undefined,
    "the window agreed on both ends",
  );
  return port;
}

/** What arrives on the responder's first port, once the port is there. */
async function inbound(t: { received: Count[] }): Promise<Count> {
  await waitFor(() => t.received.length === 1, "the inbound port");
  return t.received[0] as Count;
}

/** The highest value each `PortInfo` field reached on a mux's first port, sampled every ms. */
function watch(mux: Mux) {
  // `overshoot`: outstanding past the send window; a sender never has any.
  const max = { window: 0, sendWindow: 0, unconsumed: 0, overshoot: Number.NEGATIVE_INFINITY };
  const latest: { info?: PortInfo } = {};
  const timer = setInterval(() => {
    const info = mux.ports()[0];
    if (!info) return;
    latest.info = info;
    max.window = Math.max(max.window, info.window ?? 0);
    max.sendWindow = Math.max(max.sendWindow, info.sendWindow ?? 0);
    max.unconsumed = Math.max(max.unconsumed, info.unconsumed ?? 0);
    if (info.sendWindow !== undefined) {
      max.overshoot = Math.max(max.overshoot, (info.outstanding ?? 0) - info.sendWindow);
    }
  }, 1);
  cleanups.push(() => clearInterval(timer));
  return { max, latest };
}

/** The windows `from` announced in credits after the ack (never the ack itself). */
function announced(wire: ReturnType<typeof delayedPipe>["wire"], from: "a" | "b"): number[] {
  return wire
    .filter(({ from: f, envelope }) => f === from && envelope.type === "credit")
    .map(({ envelope }) => envelope as Extract<PortEnvelope, { type: "credit" }>)
    .filter((c) => c.caps === undefined && c.window !== undefined)
    .map((c) => c.window as number);
}

/**
 * The right edge of the window `from` grants (bytes granted plus the window),
 * after each of its credits: it never moves back, so the peer never has more
 * outstanding than the receiver accepts, whatever it last heard.
 */
function edges(wire: ReturnType<typeof delayedPipe>["wire"], from: "a" | "b"): number[] {
  const out: number[] = [];
  let granted = 0;
  let window = 0;
  for (const { from: f, envelope } of wire) {
    if (f !== from || envelope.type !== "credit") continue;
    granted += envelope.bytes;
    if (envelope.window !== undefined) window = envelope.window;
    out.push(granted + window);
  }
  return out;
}

/** Port closes that crossed the pipe, with their reasons. */
const closes = (wire: ReturnType<typeof delayedPipe>["wire"]) =>
  wire
    .filter(({ envelope }) => envelope.type === "close")
    .map(({ envelope }) => (envelope as { reason?: unknown }).reason);

const ADAPTIVE = { initial: 16 * KiB, max: 512 * KiB };

describe.each([
  ["structuredCodec (estimated sizes)", undefined, undefined],
  ["a byte codec with frames (exact sizes, checked per frame)", v8Codec, 4 * KiB],
] as const)("adaptive window over %s", (_name, codec, frameSize) => {
  it("grows under window-limited flow at a low RTT, follows on the sender, never past the ceiling", async () => {
    const t = setup(
      { kit: NEW, window: ADAPTIVE, codec, frameSize },
      { kit: NEW, window: ADAPTIVE, codec, frameSize },
    );
    const port = await openAgreed(t);
    const sender = watch(t.client);
    const total = 3 * MiB;
    const producing = produce(NEW, port, total);
    const got = await inbound(t);
    const receiver = watch(t.server);
    await producing;
    await waitFor(() => got.bytes >= total, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
    // It grew: well past the 16 KiB it started from.
    expect(receiver.max.window).toBeGreaterThanOrEqual(128 * KiB);
    expect(sender.max.sendWindow).toBeGreaterThanOrEqual(128 * KiB);
    // Never past the ceiling, on either end's report or on the wire.
    expect(receiver.max.window).toBeLessThanOrEqual(ADAPTIVE.max);
    expect(Math.max(...announced(t.wire, "b"))).toBeLessThanOrEqual(ADAPTIVE.max);
    expect(closes(t.wire)).toEqual([]);
  }, 30_000);

  it("shrinks when the RTT inflates, and fails nothing sent under the larger window", async () => {
    const t = setup(
      { kit: NEW, window: ADAPTIVE, codec, frameSize },
      { kit: NEW, window: ADAPTIVE, codec, frameSize },
      { ms: 2 },
    );
    const port = await openAgreed(t);
    let stop = false;
    const sender = watch(t.client);
    const producing = produce(NEW, port, Number.POSITIVE_INFINITY, () => stop);
    const got = await inbound(t);
    const receiver = watch(t.server);
    await waitFor(() => (receiver.latest.info?.window ?? 0) >= 256 * KiB, "the window grows");
    const peak = receiver.latest.info?.window ?? 0;
    // The path now holds bytes 15 times as long: the round trip inflates.
    t.delay.ms = 30;
    await waitFor(
      () => (receiver.latest.info?.window ?? Number.POSITIVE_INFINITY) <= peak / 2,
      "the window shrinks",
    );
    expect(receiver.latest.info?.window).toBeGreaterThanOrEqual(ADAPTIVE.initial);
    stop = true;
    const sent = await producing;
    await waitFor(() => got.bytes >= sent, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
    // Nothing was refused: no close crossed the pipe, and the port is open.
    expect(closes(t.wire)).toEqual([]);
    expect(t.server.ports()).toHaveLength(1);
    // The receiver shrank by granting less, never by moving its edge back,
    // and the sender never had more outstanding than the latest window.
    const edge = edges(t.wire, "b");
    for (let i = 1; i < edge.length; i++) {
      expect(edge[i]).toBeGreaterThanOrEqual(edge[i - 1] as number);
    }
    expect(sender.max.overshoot).toBeLessThanOrEqual(0);
  }, 30_000);
});

describe("adaptive window: memory", () => {
  it("a reader slower than the link does not grow the window", async () => {
    // One chunk every 4 ms, one at a time: about 1 MB/s.
    let chain = Promise.resolve();
    const slow = () => {
      chain = chain.then(() => sleep(4));
      return chain;
    };
    const t = setup(
      { kit: NEW, window: ADAPTIVE },
      { kit: NEW, window: ADAPTIVE },
      { ms: 1 },
      slow,
    );
    const port = await openAgreed(t);
    const producing = produce(NEW, port, 256 * KiB);
    const got = await inbound(t);
    const receiver = watch(t.server);
    await producing;
    await waitFor(() => got.bytes >= 256 * KiB, "every byte arrives");
    expect(receiver.max.window).toBeLessThanOrEqual(2 * ADAPTIVE.initial);
    expect(receiver.max.unconsumed).toBeLessThanOrEqual(2 * ADAPTIVE.initial + CHUNK);
  }, 30_000);

  it("a reader that stops after the window grew holds no more than the ceiling", async () => {
    const ceiling = 128 * KiB;
    let gate: Promise<void> | undefined;
    let release = () => {};
    const t = setup(
      { kit: NEW, window: { initial: 16 * KiB, max: ceiling } },
      { kit: NEW, window: { initial: 16 * KiB, max: ceiling } },
      { ms: 5 },
      () => gate,
    );
    const port = await openAgreed(t);
    let stop = false;
    const producing = produce(NEW, port, Number.POSITIVE_INFINITY, () => stop);
    const got = await inbound(t);
    const receiver = watch(t.server);
    await waitFor(() => (receiver.latest.info?.window ?? 0) >= ceiling, "the window grows");
    // The reader stops: nothing it gets is consumed any more.
    gate = new Promise<void>((r) => {
      release = r;
    });
    await sleep(300);
    // The sender is held: its chunks wait in its own queue, not in the receiver.
    expect(NEW.portBufferedAmount(port)).toBeGreaterThan(0);
    // What the receiver holds unconsumed never passed the ceiling (each
    // message counts its bytes and a little envelope).
    expect(receiver.max.unconsumed).toBeLessThanOrEqual(ceiling);
    expect(receiver.latest.info?.unconsumed).toBeGreaterThan(ceiling / 2);
    expect(receiver.max.window).toBeLessThanOrEqual(ceiling);
    stop = true;
    release();
    const sent = await producing;
    await waitFor(() => got.bytes >= sent, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
  }, 30_000);
});

/** Every key set a credit took after the ack, by sender. */
function creditShapes(wire: ReturnType<typeof delayedPipe>["wire"]) {
  const shapes = new Set<string>();
  for (const { from, envelope } of wire) {
    if (envelope.type !== "credit" || (envelope as { caps?: unknown }).caps) continue;
    shapes.add(`${from}: ${Object.keys(envelope).sort().join(",")}`);
  }
  return [...shapes].sort();
}

describe("fixed window: n", () => {
  it("is what 0.14 does: the same opens and acks, and no credit ever carries a window", async () => {
    const run = async (kit: Kit) => {
      const t = setup({ kit, window: 16 * KiB }, { kit, window: 16 * KiB }, { ms: 2 });
      const port = await openAgreed(t);
      const back = consume(port);
      await produce(kit, port, 512 * KiB);
      const got = await inbound(t);
      // Both ways: the responder answers on the same port.
      await produce(kit, t.inbound[0] as MessageTarget, 512 * KiB);
      await waitFor(() => got.bytes >= 512 * KiB && back.bytes >= 512 * KiB, "every byte arrives");
      return {
        handshake: t.wire
          .filter(({ envelope }) => envelope.type === "open" || "caps" in envelope)
          .map(({ from, envelope }) => ({ from, ...envelope })),
        shapes: creditShapes(t.wire),
        windows: [t.client.ports()[0]?.window, t.server.ports()[0]?.window],
      };
    };
    const now = await run(NEW);
    const before = await run(OLD);
    expect(now.handshake).toEqual(before.handshake);
    expect(now.shapes).toEqual(before.shapes);
    expect(now.shapes).toEqual(["a: bytes,id,type", "b: bytes,id,type"]);
    expect(now.windows).toEqual([16 * KiB, 16 * KiB]);
  }, 30_000);

  it("a fixed end follows the window an adaptive peer grants, and never announces one", async () => {
    const t = setup({ kit: NEW, window: 16 * KiB }, { kit: NEW, window: ADAPTIVE });
    const port = await openAgreed(t);
    const sender = watch(t.client);
    await produce(NEW, port, 2 * MiB);
    const got = await inbound(t);
    await waitFor(() => got.bytes >= 2 * MiB, "every byte arrives");
    expect(sender.max.sendWindow).toBeGreaterThan(16 * KiB);
    expect(sender.max.window).toBe(16 * KiB);
    expect(announced(t.wire, "a")).toEqual([]);
  }, 30_000);
});

describe("interop with 0.14.0", () => {
  it("the alias resolves to the published dist", () => {
    expect(import.meta.resolve("webrun-rpc-0-14")).toContain(
      "/node_modules/.pnpm/@statewalker+webrun-rpc@0.14.0/",
    );
  });

  it("0.14 opener uploading to an adaptive responder: it keeps the agreed window, nothing fails", async () => {
    const t = setup({ kit: OLD, window: 16 * KiB }, { kit: NEW, window: ADAPTIVE });
    const port = await openAgreed(t);
    const sender = watch(t.client);
    const producing = produce(OLD, port, 1 * MiB);
    const got = await inbound(t);
    const receiver = watch(t.server);
    await producing;
    await waitFor(() => got.bytes >= 1 * MiB, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
    // The old end never left the window it agreed, whatever was announced,
    // and the new one never announced less than that.
    expect(sender.max.window).toBe(16 * KiB);
    for (const w of announced(t.wire, "b")) expect(w).toBeGreaterThanOrEqual(16 * KiB);
    expect(receiver.max.window).toBeLessThanOrEqual(ADAPTIVE.max);
    expect(closes(t.wire)).toEqual([]);
  }, 30_000);

  it("0.14 responder downloading to an adaptive opener: the old sender ignores the window, nothing fails", async () => {
    const t = setup({ kit: NEW, window: ADAPTIVE }, { kit: OLD, window: 64 * KiB });
    const port = await openAgreed(t);
    const got = consume(port);
    await waitFor(() => t.inbound.length === 1, "the inbound port");
    await produce(OLD, t.inbound[0] as MessageTarget, 1 * MiB);
    await waitFor(() => got.bytes >= 1 * MiB, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
    // Agreed at the opener's 16 KiB; the 0.14 end's window stays there.
    expect(t.server.ports()[0]?.window).toBe(16 * KiB);
    for (const w of announced(t.wire, "a")) expect(w).toBeGreaterThanOrEqual(16 * KiB);
    expect(closes(t.wire)).toEqual([]);
  }, 30_000);

  it("adaptive opener uploading to a 0.14 responder: it keeps the agreed window", async () => {
    const t = setup({ kit: NEW, window: ADAPTIVE }, { kit: OLD, window: 64 * KiB });
    const port = await openAgreed(t);
    const sender = watch(t.client);
    await produce(NEW, port, 1 * MiB);
    const got = await inbound(t);
    await waitFor(() => got.bytes >= 1 * MiB, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
    expect(sender.max.sendWindow).toBe(16 * KiB);
    expect(closes(t.wire)).toEqual([]);
  }, 30_000);

  it("0.14 opener downloading from an adaptive responder: clamped to initial, and the agreed window holds", async () => {
    const t = setup({ kit: OLD, window: 1 * MiB }, { kit: NEW, window: ADAPTIVE });
    const port = await openAgreed(t);
    const got = consume(port);
    await waitFor(() => t.inbound.length === 1, "the inbound port");
    const responder = watch(t.server);
    await produce(NEW, t.inbound[0] as MessageTarget, 1 * MiB);
    await waitFor(() => got.bytes >= 1 * MiB, "every byte arrives");
    expect(got.outOfOrder).toBe(0);
    // 0.14 lists "window": the responder clamped 1 MiB to its `initial`, not
    // its ceiling, and the window grows from there only where it is read.
    expect(t.client.ports()[0]?.window).toBe(ADAPTIVE.initial);
    expect(responder.max.sendWindow).toBe(ADAPTIVE.initial);
    expect(closes(t.wire)).toEqual([]);
  }, 30_000);

  it('a 0.14 opener asking for 16 MiB of an "auto" responder is held to its initial 256 KiB', async () => {
    const t = setup({ kit: OLD, window: 16 * MiB }, { kit: NEW, window: "auto" });
    await openAgreed(t);
    expect(t.client.ports()[0]?.window).toBe(256 * KiB);
    expect(t.server.ports()[0]?.window).toBe(256 * KiB);
  }, 30_000);
});

// Over an emulated link with a rate limit (a FIFO bottleneck), from the
// statewalker/httpeers#128 prototype: what the window buys where bandwidth,
// not latency alone, bounds a port.

/** Two ends of a link: `rate` bytes/ms each way, `delayMs` one way, FIFO. */
function rateLink(rate: number, delayMs: number): [MessageTarget, MessageTarget] {
  type Listener = (event: MessageEvent) => unknown;
  const listeners: [Set<Listener>, Set<Listener>] = [new Set(), new Set()];
  const busyUntil = [0, 0];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  cleanups.push(() => {
    for (const t of timers) clearTimeout(t);
  });
  const end = (self: 0 | 1): MessageTarget => {
    const peer = self === 0 ? 1 : 0;
    return {
      postMessage(message: unknown) {
        const data = structuredClone(message);
        const now = performance.now();
        const env = data as { payload?: unknown };
        const size = estimateMessageSize(env.payload ?? data);
        const departs = Math.max(now, busyUntil[self] ?? 0) + size / rate;
        busyUntil[self] = departs;
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            for (const l of listeners[peer]) void l({ data } as MessageEvent);
          },
          departs + delayMs - now,
        );
        timers.add(timer);
      },
      addEventListener: (_type, l) => listeners[self].add(l as Listener),
      removeEventListener: (_type, l) => listeners[self].delete(l as Listener),
    };
  };
  return [end(0), end(1)];
}

/** Uploads `total` bytes on one port over a `rateLink`; times only what the window governs. */
async function upload(opts: { rate: number; delayMs: number; total: number; window: PortWindow }) {
  const [a, b] = rateLink(opts.rate, opts.delayMs);
  let got = 0;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });
  const server = NEW.multiplexPort(b, {
    codec: NEW.structuredCodec,
    side: "responder",
    window: opts.window,
    onPort: (p) => {
      p.addEventListener("message", (e) => {
        got += (e.data as Uint8Array).byteLength;
        if (got >= opts.total) done();
      });
      return true;
    },
  });
  const caller = NEW.multiplexPort(a, {
    codec: NEW.structuredCodec,
    side: "initiator",
    window: opts.window,
  });
  cleanups.push(async () => {
    await caller.close();
    await server.close();
  });
  const port = await openAgreed({ client: caller, server });
  const started = performance.now();
  for (let sent = 0; sent < opts.total; sent += 4 * KiB) {
    port.postMessage(new Uint8Array(4 * KiB));
    await NEW.whenPortReady(port, 16 * KiB);
  }
  await finished;
  return { elapsed: performance.now() - started, server, caller };
}

describe("adaptive window over a rate-limited link", () => {
  // 10 Mbit/s (1250 bytes/ms), RTT 40 ms: a BDP of 50 KB, against an 8 KiB start.
  const rate = 1250;
  const delayMs = 20;
  const total = 384 * KiB;

  it("grows past a too-small start and fills the link, where the fixed window cannot", async () => {
    const fixed = await upload({ rate, delayMs, total, window: 8 * KiB });
    const adaptive = await upload({
      rate,
      delayMs,
      total,
      window: { initial: 8 * KiB, min: 8 * KiB, max: 1024 * KiB },
    });
    expect(fixed.elapsed).toBeGreaterThan(1500);
    expect(adaptive.elapsed).toBeLessThan(fixed.elapsed / 2);
    const port = adaptive.server.ports()[0];
    expect(port?.window).toBeGreaterThan(8 * KiB);
    expect(port?.window).toBeLessThanOrEqual(1024 * KiB);
  }, 20_000);

  it("keeps the sum of a mux's windows within its budget", async () => {
    const [a, b] = rateLink(rate, delayMs);
    // Three ports at 8 KiB hold 24 KiB of a 32 KiB budget: 8 KiB is left to
    // grow by, across all three, though the link's BDP (50 KB) has room for more.
    const max = 32 * KiB;
    const budget = 32 * KiB;
    const window = { initial: 8 * KiB, min: 8 * KiB, max, budget };
    const server = NEW.multiplexPort(b, {
      codec: NEW.structuredCodec,
      side: "responder",
      window,
      onPort: (p) => {
        p.addEventListener("message", () => {});
        return true;
      },
    });
    const caller = NEW.multiplexPort(a, { codec: NEW.structuredCodec, side: "initiator", window });
    cleanups.push(async () => {
      await caller.close();
      await server.close();
    });
    const ports = await Promise.all([caller.openPort(), caller.openPort(), caller.openPort()]);
    // Before the ack nothing holds back: start once every port holds to its window.
    await waitFor(
      () =>
        caller.ports().length === 3 &&
        caller.ports().every((p) => p.window !== undefined) &&
        server.ports().length === 3 &&
        server.ports().every((p) => p.window !== undefined),
      "the windows agreed",
    );
    let peak = 0;
    let grew = 0;
    const deadline = performance.now() + 1500;
    await Promise.all(
      ports.map(async (port) => {
        while (performance.now() < deadline) {
          port.postMessage(new Uint8Array(4 * KiB));
          await NEW.whenPortReady(port, 16 * KiB);
          const windows = server.ports().map((p) => p.window ?? 0);
          peak = Math.max(
            peak,
            windows.reduce((n, w) => n + w, 0),
          );
          grew = Math.max(grew, ...windows);
        }
      }),
    );
    expect(grew).toBeGreaterThan(8 * KiB);
    expect(peak).toBeLessThanOrEqual(budget);
  }, 20_000);
});
