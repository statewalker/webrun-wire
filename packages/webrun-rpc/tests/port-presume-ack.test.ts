import { deserialize, serialize } from "node:v8";
import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import * as v08 from "webrun-rpc-0-8";
import * as v010 from "webrun-rpc-0-10";
import type {
  MessageTarget,
  PortCodec,
  PortEnvelope,
  PortInfo,
  PortMuxOptions,
} from "../src/index.js";
import * as current from "../src/index.js";

// One round trip per exchange (`presumeAck`, and a responder that holds back
// from the `open` on), measured over a link with a fixed one-way delay in
// virtual time: local work takes no time, and the clock moves only when a
// message crosses the link. What crosses it is logged, so the window can be
// checked at every step. The old ends are the published 0.10.2 and 0.8.0,
// installed under devDependency aliases.

/** One-way delay of the link, in virtual ms. */
const D = 50;
const RTT = 2 * D;
const KiB = 1024;
const WINDOW = 4 * KiB;

type Kit = Pick<
  typeof current,
  "multiplexPort" | "duplexOverPort" | "serveDuplexOverPort" | "structuredCodec"
>;
// The published packages' types come from their own `webrun-streams`; their
// shape is the same, so they are taken as this one's.
const NEW = current as Kit;
const OLD = v010 as unknown as Kit;
const V08 = v08 as unknown as Kit;

type Mux = ReturnType<Kit["multiplexPort"]>;

/** What crossed the link: when it was posted, from which end, and what. */
interface Sent {
  at: number;
  from: "a" | "b";
  data: unknown;
}

interface LinkEnd extends MessageTarget {
  close(): void;
}

/**
 * Two ends of a pipe whose messages arrive `delay` virtual ms after they are
 * posted, in order. Nothing moves until `runUntil` / `drain` deliver it; they
 * let all local work settle (the mux's timers and tasks, the streams'
 * promises) before each delivery, so local work takes no virtual time.
 */
function virtualLink(delay = D) {
  let now = 0;
  let seq = 0;
  let activity = 0;
  const queue: { at: number; seq: number; deliver: () => void }[] = [];
  const wire: Sent[] = [];
  const errors: unknown[] = [];

  const makeEnd = (name: "a" | "b") => {
    const listeners = new Set<(event: MessageEvent) => unknown>();
    let closed = false;
    const end: LinkEnd & { receive(data: unknown): void } = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message, transfer) {
        if (closed) return;
        const data = structuredClone(message, transfer ? { transfer } : undefined);
        activity++;
        wire.push({ at: now, from: name, data });
        const peer = name === "a" ? b : a;
        queue.push({ at: now + delay, seq: seq++, deliver: () => peer.receive(data) });
      },
      close() {
        closed = true;
      },
      receive(data) {
        if (closed) return;
        const event = new MessageEvent("message", { data });
        for (const listener of [...listeners]) {
          try {
            void listener(event);
          } catch (err) {
            errors.push(err);
          }
        }
      },
    };
    return end;
  };
  const a = makeEnd("a");
  const b = makeEnd("b");

  const settle = async () => {
    let quiet = 0;
    while (quiet < 3) {
      const before = activity;
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
      quiet = activity === before ? quiet + 1 : 0;
    }
  };

  /** Delivers the next message; `false` when nothing is in flight. */
  const step = (): boolean => {
    queue.sort((x, y) => x.at - y.at || x.seq - y.seq);
    const next = queue.shift();
    if (!next) return false;
    now = next.at;
    activity++;
    next.deliver();
    return true;
  };

  return {
    a: a as LinkEnd,
    b: b as LinkEnd,
    wire,
    errors,
    now: () => now,
    /** Runs the link until `done()` holds; `check` runs after every settled step. */
    async runUntil(done: () => boolean, check: () => void = () => {}) {
      const since = now;
      for (;;) {
        await settle();
        check();
        if (done()) return;
        if (!step()) throw new Error("the link went idle before the condition held");
        if (now - since > 200 * delay) {
          throw new Error("the condition did not hold within 200 delays");
        }
      }
    },
    /** Runs the link until nothing is in flight. */
    async drain(check: () => void = () => {}) {
      for (;;) {
        await settle();
        check();
        if (!step()) return;
      }
    },
  };
}

type Link = ReturnType<typeof virtualLink>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const HEAD = bytes(32, 1);
const BODY = bytes(512, 2);

/** Reads its whole input, then answers with a head and a body. */
const readAllThenAnswer: Duplex = async function* (input) {
  for await (const _ of input) {
    // the request
  }
  yield HEAD;
  yield BODY;
};

/** Answers as soon as the request's first chunk is in, as an HTTP server answers a GET. */
const answerAtFirstChunk: Duplex = async function* (input) {
  for await (const _ of input) break;
  yield HEAD;
  yield BODY;
};

/** Sums its input's bytes and answers with the count. */
const countBytes: Duplex = async function* (input) {
  let n = 0;
  for await (const chunk of input) n += chunk.byteLength;
  yield new TextEncoder().encode(String(n));
};

interface Side {
  kit: Kit;
  options?: Partial<PortMuxOptions>;
}

/**
 * An opening mux on end `a` and a serving one on end `b` (or the other way
 * round with `swap`: the `side: "responder"` mux opens). `handler` serves
 * every port that `onPort` (given the port's meta) does not refuse.
 */
function pair(
  link: Link,
  opener: Side,
  responder: Side,
  handler: Duplex,
  { swap = false, onPort }: { swap?: boolean; onPort?: (meta: unknown) => boolean } = {},
) {
  const servedOn = swap ? link.a : link.b;
  const openedOn = swap ? link.b : link.a;
  const server = responder.kit.multiplexPort(servedOn, {
    codec: responder.kit.structuredCodec,
    side: swap ? "initiator" : "responder",
    window: WINDOW,
    ...responder.options,
    onPort: (port, meta) => {
      if (onPort && !onPort(meta)) return false;
      responder.kit.serveDuplexOverPort(port, handler);
      return true;
    },
  } as PortMuxOptions) as Mux;
  const client = opener.kit.multiplexPort(openedOn, {
    codec: opener.kit.structuredCodec,
    side: swap ? "responder" : "initiator",
    window: WINDOW,
    ...opener.options,
  } as PortMuxOptions) as Mux;
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, server };
}

interface Exchange {
  /** Virtual time of each response chunk, from the exchange's start. */
  chunks: number[];
  /** Virtual time the response ended (or failed), from the start. */
  end?: number;
  received: Uint8Array[];
  error?: unknown;
}

/** Starts one exchange on a new port of `client`; it runs as the link is run. */
function start(
  link: Link,
  kit: Kit,
  client: Mux,
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  meta?: unknown,
): Exchange {
  const t0 = link.now();
  const exchange: Exchange = { chunks: [], received: [] };
  void (async () => {
    try {
      const port = await client.openPort(meta);
      for await (const chunk of kit.duplexOverPort(port)(input)) {
        exchange.chunks.push(link.now() - t0);
        exchange.received.push(chunk);
      }
    } catch (err) {
      exchange.error = err;
    } finally {
      exchange.end = link.now() - t0;
    }
  })();
  return exchange;
}

/** Runs one exchange to its end, then lets the link go quiet. */
async function run(
  link: Link,
  kit: Kit,
  client: Mux,
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  check?: () => void,
  meta?: unknown,
): Promise<Exchange> {
  const exchange = start(link, kit, client, input, meta);
  await link.runUntil(() => exchange.end !== undefined, check);
  await link.drain(check);
  return exchange;
}

/** A request: one chunk, then its end. */
const request = () => [bytes(64, 7)];

/** An upload: `n` chunks of `size` bytes, produced one by one. */
async function* upload(n: number, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < n; i++) yield bytes(size, i);
}

/** Head and body, both, in one round trip; the exchange ends with them. */
function expectOneRoundTrip(exchange: Exchange) {
  expect(exchange.error).toBeUndefined();
  expect(exchange.received.map((c) => c.byteLength)).toEqual([HEAD.byteLength, BODY.byteLength]);
  expect(exchange.chunks).toEqual([RTT, RTT]);
  expect(exchange.end).toBe(RTT);
}

/** The early answer: a zero-byte credit from the opener, posted with its `open`. */
function earlyAnswers(link: Link, opener: "a" | "b" = "a") {
  const opens = new Map<number, number>();
  const answers: number[] = [];
  for (const { at, from, data } of link.wire) {
    const envelope = data as PortEnvelope;
    if (from !== opener) continue;
    if (envelope.type === "open") opens.set(envelope.id, at);
    else if (envelope.type === "credit" && envelope.bytes === 0 && opens.get(envelope.id) === at) {
      answers.push(envelope.id);
    }
  }
  return answers;
}

describe("presumeAck, new ends on both sides", () => {
  it("rejects a value it does not know", () => {
    const link = virtualLink();
    expect(() =>
      NEW.multiplexPort(link.a, {
        codec: NEW.structuredCodec,
        presumeAck: "sometimes" as never,
      }),
    ).toThrow(RangeError);
  });

  it("by default the first port runs the full handshake, and every later one takes one round trip", async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: NEW }, { kit: NEW }, readAllThenAnswer);
    const first = await run(link, NEW, client, request());
    expect(first.error).toBeUndefined();
    expect(first.end).toBe(2 * RTT);
    for (let i = 0; i < 3; i++) expectOneRoundTrip(await run(link, NEW, client, request()));
  });

  it('"always" takes one round trip from the first port', async () => {
    const link = virtualLink();
    const { client } = pair(
      link,
      { kit: NEW, options: { presumeAck: "always" } },
      { kit: NEW },
      readAllThenAnswer,
    );
    expectOneRoundTrip(await run(link, NEW, client, request()));
    expectOneRoundTrip(await run(link, NEW, client, request()));
  });

  it("a streamed upload, its end behind its chunks, takes one round trip", async () => {
    const link = virtualLink();
    const { client } = pair(
      link,
      { kit: NEW, options: { presumeAck: "always" } },
      { kit: NEW },
      countBytes,
    );
    const exchange = await run(link, NEW, client, upload(6, 500));
    expect(exchange.error).toBeUndefined();
    expect(new TextDecoder().decode(exchange.received[0])).toBe("3000");
    expect(exchange.chunks).toEqual([RTT]);
    expect(exchange.end).toBe(RTT);
  });

  it("from either mux: the responder side opening takes one round trip too", async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: NEW }, { kit: NEW }, readAllThenAnswer, { swap: true });
    await run(link, NEW, client, request());
    expectOneRoundTrip(await run(link, NEW, client, request()));
    expect(earlyAnswers(link, "b").length).toBe(1);
  });

  it("many concurrent exchanges each take one round trip", async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: NEW }, { kit: NEW }, readAllThenAnswer);
    await run(link, NEW, client, request());
    const exchanges = Array.from({ length: 20 }, () => start(link, NEW, client, request()));
    await link.runUntil(() => exchanges.every((x) => x.end !== undefined));
    for (const exchange of exchanges) expectOneRoundTrip(exchange);
  });

  it('"never" waits for the ack on every port, and posts no early answer', async () => {
    const link = virtualLink();
    const { client } = pair(
      link,
      { kit: NEW, options: { presumeAck: "never" } },
      { kit: NEW },
      readAllThenAnswer,
    );
    for (let i = 0; i < 2; i++) {
      const exchange = await run(link, NEW, client, request());
      expect(exchange.error).toBeUndefined();
      expect(exchange.end).toBe(2 * RTT);
    }
    expect(earlyAnswers(link)).toEqual([]);
  });

  it('with "never", the responder still answers a GET in one round trip once it has read credit', async () => {
    const link = virtualLink();
    const { client } = pair(
      link,
      { kit: NEW, options: { presumeAck: "never" } },
      { kit: NEW },
      answerAtFirstChunk,
    );
    const first = await run(link, NEW, client, request());
    // The first port: the responder waits for the opener's answer to its ack.
    expect(first.chunks).toEqual([RTT, 2 * RTT]);
    expectOneRoundTrip(await run(link, NEW, client, request()));
  });

  it("over a byte codec that counts exact sizes, framed messages go before the ack and arrive whole", async () => {
    const link = virtualLink();
    const { client } = pair(
      link,
      { kit: NEW, options: { codec: v8Codec, frameSize: 300 } },
      { kit: NEW, options: { codec: v8Codec, frameSize: 300 } },
      countBytes,
    );
    await run(link, NEW, client, upload(1, 10));
    const exchange = await run(link, NEW, client, upload(3, 1000));
    expect(exchange.error).toBeUndefined();
    expect(new TextDecoder().decode(exchange.received[0])).toBe("3000");
    expect(exchange.end).toBe(RTT);
    // The second port's request went as frames, before its ack.
    const frames = link.wire.filter(
      (s) => s.from === "a" && (v8Codec.decode?.(s.data) as PortEnvelope)?.type === "frame",
    );
    expect(frames.length).toBeGreaterThan(0);
  });
});

/** A byte codec that counts exact sizes: Node's structured serializer. */
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

describe("interop with 0.10.2", () => {
  it("the alias resolves to the published dist", () => {
    expect(import.meta.resolve("webrun-rpc-0-10")).toContain(
      "/node_modules/.pnpm/@statewalker+webrun-rpc@0.10.2/",
    );
  });

  it("old with old, unchanged: a request takes two round trips, and a GET's body comes one after its head", async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: OLD }, { kit: OLD }, readAllThenAnswer);
    for (let i = 0; i < 2; i++) {
      const exchange = await run(link, OLD, client, request());
      expect(exchange.error).toBeUndefined();
      expect(exchange.end).toBe(2 * RTT);
    }
    const get = virtualLink();
    const { client: getClient } = pair(get, { kit: OLD }, { kit: OLD }, answerAtFirstChunk);
    for (let i = 0; i < 2; i++) {
      expect((await run(get, OLD, getClient, request())).chunks).toEqual([RTT, 2 * RTT]);
    }
  });

  it('new opener, old responder: from the second port on (or the first, with "always") an exchange takes one round trip', async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: NEW }, { kit: OLD }, readAllThenAnswer);
    expect((await run(link, NEW, client, request())).end).toBe(2 * RTT);
    expectOneRoundTrip(await run(link, NEW, client, request()));

    const always = virtualLink();
    const { client: eager } = pair(
      always,
      { kit: NEW, options: { presumeAck: "always" } },
      { kit: OLD },
      countBytes,
    );
    const exchange = await run(always, NEW, eager, upload(6, 500));
    expect(new TextDecoder().decode(exchange.received[0])).toBe("3000");
    expect(exchange.end).toBe(RTT);
  });

  it("new opener, old responder: many concurrent exchanges each take one round trip", async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: NEW }, { kit: OLD }, readAllThenAnswer);
    await run(link, NEW, client, request());
    const exchanges = Array.from({ length: 20 }, () => start(link, NEW, client, request()));
    await link.runUntil(() => exchanges.every((x) => x.end !== undefined));
    for (const exchange of exchanges) expectOneRoundTrip(exchange);
  });

  it("old opener, new responder: a GET's head and body come together from the second port on", async () => {
    const link = virtualLink();
    const { client } = pair(link, { kit: OLD }, { kit: NEW }, answerAtFirstChunk);
    expect((await run(link, OLD, client, request())).chunks).toEqual([RTT, 2 * RTT]);
    for (let i = 0; i < 2; i++) {
      expect((await run(link, OLD, client, request())).chunks).toEqual([RTT, RTT]);
    }
    // The old opener's own request still waits for the ack: two round trips.
    const uploads = virtualLink();
    const { client: uploader } = pair(uploads, { kit: OLD }, { kit: NEW }, readAllThenAnswer);
    for (let i = 0; i < 2; i++) {
      expect((await run(uploads, OLD, uploader, request())).end).toBe(2 * RTT);
    }
  });

  it("streams larger than the window complete in all four pairings", async () => {
    for (const [opener, responder] of [
      [NEW, NEW],
      [NEW, OLD],
      [OLD, NEW],
      [OLD, OLD],
    ] as const) {
      const link = virtualLink();
      const { client } = pair(link, { kit: opener }, { kit: responder }, countBytes);
      for (let i = 0; i < 3; i++) {
        const exchange = await run(link, opener, client, upload(40, 500));
        expect(exchange.error).toBeUndefined();
        expect(new TextDecoder().decode(exchange.received[0])).toBe("20000");
      }
    }
  });
});

/**
 * At every step: neither end has more of a port's bytes delivered and not
 * consumed than the window, nor more sent and not granted back. A message is
 * smaller than the window here, so honest counting never passes it.
 */
function windowHolds(muxes: Mux[]) {
  return () => {
    for (const mux of muxes) {
      for (const info of mux.ports?.() ?? ([] as PortInfo[])) {
        expect(info.outstanding ?? 0).toBeLessThanOrEqual(WINDOW);
        expect(info.unconsumed ?? 0).toBeLessThanOrEqual(WINDOW);
      }
    }
  };
}

/** Reads nothing until `release()`, then counts its input. */
function stalled() {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const handler: Duplex = async function* (input) {
    await gate;
    yield* countBytes(input);
  };
  return { handler, release };
}

describe("the window holds before the ack", () => {
  for (const [name, responder] of [
    ["new", NEW],
    ["0.10.2", OLD],
  ] as const) {
    it(`a presumed upload to a stalled ${name} responder stops at the window, then completes`, async () => {
      const link = virtualLink();
      const { handler, release } = stalled();
      const { client, server } = pair(
        link,
        { kit: NEW, options: { presumeAck: "always" } },
        { kit: responder },
        handler,
      );
      const check = windowHolds([client, server]);
      const exchange = start(link, NEW, client, upload(40, 500));
      await link.drain(check);
      // Stalled: the opener holds back what the window does not admit.
      const [info] = client.ports?.() ?? [];
      expect(info?.queued ?? 0).toBeGreaterThan(0);
      expect(exchange.end).toBeUndefined();
      release();
      await link.runUntil(() => exchange.end !== undefined, check);
      expect(exchange.error).toBeUndefined();
      expect(new TextDecoder().decode(exchange.received[0])).toBe("20000");
    });
  }

  it("a responder whose codec drops credit never holds back early, however many ports it serves", async () => {
    const link = virtualLink();
    const dropsCredit: PortCodec = {
      post: (port, envelope, transfer) => NEW.structuredCodec.post(port, envelope, transfer),
      read: (event) => {
        const envelope = NEW.structuredCodec.read(event);
        return envelope?.type === "credit" ? undefined : envelope;
      },
    };
    // More than a window back: a responder that held back would wait for
    // credit its codec never hands it.
    const download: Duplex = async function* (input) {
      for await (const _ of input) {
        // the request
      }
      yield* upload(20, 500);
    };
    const { client } = pair(
      link,
      { kit: NEW },
      { kit: NEW, options: { codec: dropsCredit } },
      download,
    );
    for (let i = 0; i < 3; i++) {
      const exchange = await run(link, NEW, client, request());
      expect(exchange.error).toBeUndefined();
      expect(exchange.received.reduce((n, c) => n + c.byteLength, 0)).toBe(10_000);
    }
  });
});

describe("refusals and contradictions", () => {
  it("a port refused without an ack (maxPorts) fails; the responder holds none of its bytes, and later ports still presume", async () => {
    const link = virtualLink();
    const { handler, release } = stalled();
    const { client, server } = pair(
      link,
      { kit: NEW, options: { presumeAck: "always" } },
      { kit: NEW, options: { maxPorts: 1 } },
      handler,
    );
    const holder = start(link, NEW, client, upload(1, 10));
    await link.drain();
    const refused = start(link, NEW, client, upload(40, 500));
    await link.runUntil(() => refused.end !== undefined);
    expect(refused.error).toBeDefined();
    expect(server.ports?.().length).toBe(1);
    expect(server.ports?.()[0]?.unconsumed ?? 0).toBeLessThanOrEqual(WINDOW);
    // Up to a window went before the refusal arrived, and no more.
    const refusedId = link.wire
      .map((s) => s.data as PortEnvelope)
      .filter((e) => e.type === "open")
      .at(-1)?.id;
    const sent = link.wire.filter(
      (s) =>
        s.from === "a" &&
        (s.data as PortEnvelope).type === "message" &&
        (s.data as PortEnvelope).id === refusedId,
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(WINDOW / 500 + 1);
    release();
    await link.runUntil(() => holder.end !== undefined);
    await link.drain();
    expect(client.ports?.()).toEqual([]);
    const later = await run(link, NEW, client, upload(1, 10));
    expect(later.error).toBeUndefined();
    expect(later.end).toBe(RTT);
  });

  it("a port rejected after its ack (onPort) fails, and later ports still presume", async () => {
    const link = virtualLink();
    const { client, server } = pair(
      link,
      { kit: NEW, options: { presumeAck: "always" } },
      { kit: NEW },
      countBytes,
      { onPort: (meta) => meta !== "reject" },
    );
    const rejected = await run(link, NEW, client, upload(40, 500), undefined, "reject");
    expect(rejected.error).toBeDefined();
    expect(server.ports?.()).toEqual([]);
    expect(client.ports?.()).toEqual([]);
    const later = await run(link, NEW, client, upload(3, 100));
    expect(later.error).toBeUndefined();
    expect(new TextDecoder().decode(later.received[0])).toBe("300");
    expect(later.end).toBe(RTT);
  });

  it('"always" against a peer that acks without capabilities (0.8.0): the port that relied on it fails, later ports run the full handshake', async () => {
    const link = virtualLink();
    const { client } = pair(
      link,
      { kit: NEW, options: { presumeAck: "always" } },
      { kit: V08 },
      countBytes,
    );
    const failed = await run(link, NEW, client, upload(3, 100));
    expect(String(failed.error)).toMatch(/presumeAck/);
    const sinceFailure = link.wire.length;
    for (let i = 0; i < 2; i++) {
      const later = await run(link, NEW, client, upload(3, 100));
      expect(later.error).toBeUndefined();
      expect(new TextDecoder().decode(later.received[0])).toBe("300");
    }
    // No early answer since the contradiction.
    expect(earlyAnswers({ ...link, wire: link.wire.slice(sinceFailure) } as Link)).toEqual([]);
  });

  it("a contradicted port that sent nothing yet takes the ack as it is and works", async () => {
    const link = virtualLink();
    const got: unknown[] = [];
    const server = V08.multiplexPort(link.b, {
      codec: V08.structuredCodec,
      side: "responder",
      onPort: (port) => {
        port.addEventListener("message", (e) => {
          got.push(e.data);
          port.postMessage(e.data);
        });
        return true;
      },
    } as PortMuxOptions) as Mux;
    const client = NEW.multiplexPort(link.a, {
      codec: NEW.structuredCodec,
      window: WINDOW,
      presumeAck: "always",
    });
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const port = await client.openPort();
    const echoed: unknown[] = [];
    port.addEventListener("message", (e) => {
      echoed.push(e.data);
    });
    await link.drain();
    expect(client.ports()[0]?.window).toBe(WINDOW);
    for (let i = 0; i < 20; i++) port.postMessage(bytes(500, i));
    await link.runUntil(() => echoed.length === 20);
    expect(got.length).toBe(20);
  });

  it("an ack whose sizing contradicts the presumption fails the port that sent, and turns presumption off", async () => {
    const link = virtualLink();
    // The responder reads bytes but cannot count them exactly (no encode / decode).
    const inexact: PortCodec = { post: v8Codec.post, read: v8Codec.read, halfClose: true };
    const { client } = pair(
      link,
      { kit: NEW, options: { codec: v8Codec, presumeAck: "always" } },
      { kit: NEW, options: { codec: inexact } },
      countBytes,
    );
    const failed = await run(link, NEW, client, upload(3, 100));
    expect(String(failed.error)).toMatch(/presumeAck/);
    const later = await run(link, NEW, client, upload(3, 100));
    expect(later.error).toBeUndefined();
    expect(new TextDecoder().decode(later.received[0])).toBe("300");
  });
});
