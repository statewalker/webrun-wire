import { describe, expect, it } from "vitest";
import { type ByteChannel, emulateMux, newCreditLedger } from "../src/index.js";

const FRAME_NAMES: Record<number, string> = {
  1: "OPEN",
  2: "DATA",
  3: "ACK",
  4: "END",
  5: "ERROR",
  6: "CLOSE",
};

/** Decodes the varint stream id, both to locate the type byte and to report it. */
function frameInfo(frame: Uint8Array): { id: number; type: string; payload: Uint8Array } {
  let offset = 0;
  let id = 0;
  let shift = 0;
  while (offset < frame.byteLength) {
    const byte = frame[offset++] ?? 0;
    id |= (byte & 0x7f) << shift;
    if (byte < 0x80) break;
    shift += 7;
  }
  const type = FRAME_NAMES[frame[offset] ?? 0] ?? "?";
  return { id, type, payload: frame.subarray(offset + 1) };
}

interface TracedPair {
  a: ByteChannel;
  b: ByteChannel;
  sent: { from: "a" | "b"; id: number; type: string; payload: Uint8Array }[];
}

function tracedPair(): TracedPair {
  const sent: TracedPair["sent"] = [];
  const queues: Record<"a" | "b", Uint8Array[]> = { a: [], b: [] };
  const pending: Record<"a" | "b", ((r: IteratorResult<Uint8Array>) => void) | null> = {
    a: null,
    b: null,
  };
  let closed = false;
  const closers: (() => void)[] = [];
  const closedPromise = new Promise<void>((r) => closers.push(r));

  const deliver = (to: "a" | "b", bytes: Uint8Array): void => {
    if (closed) return;
    const waiting = pending[to];
    if (waiting) {
      pending[to] = null;
      waiting({ value: bytes, done: false });
    } else queues[to].push(bytes);
  };

  const makeChannel = (self: "a" | "b", peer: "a" | "b"): ByteChannel => ({
    send(bytes) {
      const { id, type, payload } = frameInfo(bytes);
      sent.push({ from: self, id, type, payload: new Uint8Array(payload) });
      deliver(peer, new Uint8Array(bytes));
    },
    recv: {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const queued = queues[self].shift();
          if (queued) {
            yield queued;
            continue;
          }
          const nextValue = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending[self] = resolve;
          });
          if (nextValue.done) return;
          yield nextValue.value;
        }
      },
    },
    closed: closedPromise,
    close() {
      closed = true;
      for (const c of closers) c();
      pending.a?.({ value: undefined as never, done: true });
      pending.b?.({ value: undefined as never, done: true });
    },
  });

  return { a: makeChannel("a", "b"), b: makeChannel("b", "a"), sent };
}

/** Total DATA bytes one side has put on the wire. */
function dataBytes(sent: TracedPair["sent"], from: "a" | "b"): number {
  return sent
    .filter((f) => f.from === from && f.type === "DATA")
    .reduce((sum, f) => sum + f.payload.byteLength, 0);
}

/** The same, split by stream id, so a per-stream claim has a witness. */
function dataBytesByStream(sent: TracedPair["sent"], from: "a" | "b"): Map<number, number> {
  const perStream = new Map<number, number>();
  for (const f of sent) {
    if (f.from !== from || f.type !== "DATA") continue;
    perStream.set(f.id, (perStream.get(f.id) ?? 0) + f.payload.byteLength);
  }
  return perStream;
}

describe("credit advertisement", () => {
  it("puts the opener's maxStreamBuffer in the OPEN payload", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 1 << 20 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    const gen = client.call([new Uint8Array([1])]);
    await gen.next();

    const open = sent.find((f) => f.from === "a" && f.type === "OPEN");
    expect(open).toBeDefined();
    const payload = (open as { payload: Uint8Array }).payload;
    expect(payload.byteLength).toBe(4);
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(0, false)).toBe(1 << 20);

    await gen.return(undefined as never);
    await client.close();
    await server.close();
  });

  it("answers OPEN with an ACK carrying the responder's maxStreamBuffer, before anything else", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 2 << 20 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    const gen = client.call([new Uint8Array([1])]);
    await gen.next();

    // The FIRST frame b sends must be the advertisement. Searching for "some
    // ACK somewhere" would also match a drain grant and prove nothing about
    // which one answered OPEN.
    const first = sent.filter((f) => f.from === "b")[0];
    expect(first?.type).toBe("ACK");
    const payload = (first as { payload: Uint8Array }).payload;
    expect(payload.byteLength).toBe(4);
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(0, false)).toBe(2 << 20);

    await gen.return(undefined as never);
    await client.close();
    await server.close();
  });
});

describe("window bounds", () => {
  it("refuses a maxStreamBuffer of zero, which would authorise nothing", () => {
    const { a } = tracedPair();
    expect(() => emulateMux(a, { side: "initiator", maxStreamBuffer: 0 })).toThrow(RangeError);
  });

  it("transfers through a window larger than the uint32 credit field", async () => {
    // 4 GiB is 2^32 exactly. Encoding that advertisement with `n >>> 0` puts
    // **0** on the wire — no credit at all — and both sides stall silently
    // forever. Measured before the clamp: 0 of 4096 bytes after one second.
    const { a, b } = tracedPair();
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 4 * 1024 * 1024 * 1024 });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 8 * 1024 * 1024 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
      yield new Uint8Array(0);
    });

    const gen = client.call([new Uint8Array(4096)]);
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    const deadline = Date.now() + 2000;
    while (received < 4096 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toBe(4096);

    await client.close();
    await server.close();
  });
});

describe("credit bounds the sender", () => {
  it("never puts more bytes on the wire than the peer advertised", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4096 });
    server.serve(async function* neverDrains() {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const gen = client.call(
      (async function* () {
        for (let i = 0; i < 40; i++) yield new Uint8Array(1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* stream torn down */
      }
    })();
    await new Promise((r) => setTimeout(r, 60));

    // 40 KiB offered, 4 KiB granted: the whole window and not one byte more.
    // A floor as well as a ceiling — `toBeLessThanOrEqual` alone is satisfied
    // by a mux that grants nothing and therefore sends nothing, which is not
    // the property this test exists to pin.
    expect(dataBytes(sent, "a")).toBe(4096);
    expect(sent.some((f) => f.from === "b" && f.type === "ERROR")).toBe(false);

    await client.close();
    await server.close();
  });

  it("bounds aggregate in-flight bytes at streams x window", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4096 });
    server.serve(async function* neverDrains() {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const streams = 8;
    const gens = Array.from({ length: streams }, () =>
      client.call(
        (async function* () {
          for (let i = 0; i < 40; i++) yield new Uint8Array(1024);
        })(),
      ),
    );
    for (const gen of gens) {
      void (async () => {
        try {
          for await (const _c of gen) {
            /* drain */
          }
        } catch {
          /* stream torn down */
        }
      })();
    }
    await new Promise((r) => setTimeout(r, 80));

    // The window is per stream and there is no mux-wide budget, so the bound
    // the design offers is exactly this product. It is the number the README
    // must quote next to `maxStreamBuffer`.
    //
    // The floor and the per-stream witness are both load-bearing: an upper
    // bound alone is satisfied by a mux that grants nothing, and equally by
    // one that credits a single stream out of the eight — neither of which
    // establishes a per-stream product.
    const perStream = dataBytesByStream(sent, "a");
    expect(perStream.size).toBe(streams);
    for (const bytes of perStream.values()) expect(bytes).toBe(4096);
    expect(dataBytes(sent, "a")).toBe(streams * 4096);

    await client.close();
    await server.close();
  });
});

describe("credit replenishment", () => {
  it("a sender stalled at zero credit resumes once the consumer drains", async () => {
    const { a, b } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, {
      side: "responder",
      mtu: 1024,
      maxStreamBuffer: 4 * 1024,
    });

    let received = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    server.serve(async function* counting(input) {
      await gate;
      for await (const chunk of input) received += chunk.byteLength;
      // biome's `lint/correctness/useYield` is an error, not a warning, and a
      // handler that only consumes has no natural yield. An empty chunk is
      // skipped by `pumpOutbound`, so it costs no frame.
      yield new Uint8Array(0);
    });

    const total = 40;
    const gen = client.call(
      (async function* () {
        for (let i = 0; i < total; i++) yield new Uint8Array(1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    // Consumer is gated: the sender fills the window and stalls well short.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(0);

    // Open the gate; grants flow and the whole stream must complete.
    release();
    const deadline = Date.now() + 2000;
    while (received < total * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toBe(total * 1024);

    await client.close();
    await server.close();
  });

  it("completes when the sender's mtu is larger than the peer's whole window", async () => {
    const { a, b } = tracedPair();
    // 64 KiB mtu on the caller, 4 KiB window on the responder. A sender that
    // framed at its own mtu and then reserved that much would park forever on
    // a reservation the peer can never cover.
    const client = emulateMux(a, { side: "initiator", mtu: 64 * 1024 });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 4 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
      yield new Uint8Array(0);
    });

    const gen = client.call([new Uint8Array(64 * 1024)]);
    const errors: unknown[] = [];
    try {
      for await (const _c of gen) {
        /* drain */
      }
    } catch (err) {
      errors.push(err);
    }

    const deadline = Date.now() + 2000;
    while (received < 64 * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(errors).toEqual([]);
    expect(received).toBe(64 * 1024);

    await client.close();
    await server.close();
  });
});

describe("asymmetric configuration", () => {
  it("a large-buffer sender and a small-buffer receiver transfer without teardown", async () => {
    const { a, b } = tracedPair();
    // The sender would happily hold 8 MiB; the receiver can hold 4 KiB.
    // Under a sender-side window each peer's local check passes and the
    // stream is torn down. Under credit the sender is simply granted less.
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 8 * 1024 * 1024 });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
      yield new Uint8Array(0);
    });

    const total = 64;
    const gen = client.call(
      (async function* () {
        for (let i = 0; i < total; i++) yield new Uint8Array(1024);
      })(),
    );
    const errors: unknown[] = [];
    await (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch (err) {
        errors.push(err);
      }
    })();

    const deadline = Date.now() + 2000;
    while (received < total * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(errors).toEqual([]);
    expect(received).toBe(total * 1024);

    await client.close();
    await server.close();
  });
});

describe("sub-threshold traffic", () => {
  // Regression test, not a TDD cycle. The protocol review found a permanent
  // deadlock here: with a `spend(exact)` ledger the sender parks needing more
  // than the window's remainder, and with an unflushed grantor the receiver's
  // 300-byte drain stays below the 512-byte trigger, so neither side moves.
  //
  // Be precise about what kills this test, because an earlier draft was not.
  // It is the **pair** of those two changes, not either one alone: measured,
  // `spend(exact)` with the flush intact leaves it green (1 failed | 9 passed
  // in this file), dropping only the flush leaves it green (0 failed here),
  // and applying both fails it on `expected 300 to be 1200` — the sender got
  // exactly its first chunk out and then stopped. That pair is a row in
  // Step 5's mutation table, so this test's claim to be load-bearing is
  // checked rather than asserted.
  it("completes a response whose chunks straddle the batching threshold", async () => {
    const { a, b } = tracedPair();
    // 1 KiB window, so grants batch at 512 bytes; 300 then 900 against it.
    const client = emulateMux(a, { side: "initiator", mtu: 1024, maxStreamBuffer: 1024 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* twoChunks() {
      yield new Uint8Array(300);
      await new Promise((r) => setTimeout(r, 20));
      yield new Uint8Array(900);
    });

    let received = 0;
    const drained = (async () => {
      for await (const chunk of client.call([])) {
        received += chunk.byteLength;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await Promise.race([drained, new Promise((r) => setTimeout(r, 1500))]);
    expect(received).toBe(1200);

    await client.close();
    await server.close();
  });
});

describe("credit teardown", () => {
  it("a sender parked in reserve unwinds when its stream is torn down", async () => {
    // The peer registers no handler, so it answers OPEN with ERROR and never
    // advertises: the sender is parked in `reserve()` at exactly zero credit
    // when the teardown arrives. Without `outboundCredit.fail(...)` in
    // `teardownStream` that reservation is never settled, the producer's
    // `finally` never runs, and the generator leaks for the life of the mux.
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    emulateMux(b, { side: "responder" });

    let producerFinally = false;
    const gen = client.call(
      (async function* stalls() {
        try {
          for (let i = 0; i < 40; i++) yield new Uint8Array(1024);
        } finally {
          producerFinally = true;
        }
      })(),
    );
    const errors: unknown[] = [];
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch (err) {
        errors.push(err);
      }
    })();

    const deadline = Date.now() + 1000;
    while (!producerFinally && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(producerFinally).toBe(true);
    // Nothing was ever authorised, so nothing was ever framed.
    expect(dataBytes(sent, "a")).toBe(0);
    expect(errors.length).toBe(1);

    await client.close();
  });

  it("a grant arriving after failure neither revives the ledger nor throws", async () => {
    // The ledger-level half of the teardown path, which the wire cannot show:
    // once `teardownStream` has failed the ledger, a late ACK for that stream
    // must be inert. On the wire the late grant is dropped earlier still (the
    // stream is gone from the map), so this is the only place the ledger's own
    // post-`fail` behaviour is pinned. It lives in this file because Task 3
    // commits only the files its brief names.
    const ledger = newCreditLedger(0);
    const parked = ledger.reserve(1024);
    ledger.fail(new Error("emulateMux: stream closed"));
    await expect(parked).rejects.toThrow("emulateMux: stream closed");

    ledger.grant(4096);
    expect(ledger.available).toBe(0);
    await expect(ledger.reserve(1)).rejects.toThrow("emulateMux: stream closed");
  });
});

/**
 * A one-directional channel for feeding raw, hand-built frames to one side of
 * `emulateMux` as if a peer had sent them — no mux runs on the other end.
 * Captures every frame the wrapped side sends back, parsed the same way
 * `tracedPair` does, so a malformed frame can be injected and a real one
 * observed without a second `emulateMux` instance racing the injection.
 */
function injectionChannel(): {
  channel: ByteChannel;
  inject: (bytes: Uint8Array) => void;
  sent: { id: number; type: string; payload: Uint8Array }[];
} {
  const sent: { id: number; type: string; payload: Uint8Array }[] = [];
  const queue: Uint8Array[] = [];
  let pending: ((r: IteratorResult<Uint8Array>) => void) | null = null;

  const inject = (bytes: Uint8Array): void => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve({ value: bytes, done: false });
    } else {
      queue.push(bytes);
    }
  };

  const channel: ByteChannel = {
    send(bytes) {
      const { id, type, payload } = frameInfo(bytes);
      sent.push({ id, type, payload: new Uint8Array(payload) });
    },
    recv: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = queue.shift();
          if (queued) return Promise.resolve({ value: queued, done: false });
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending = resolve;
          });
        },
      }),
    } as AsyncIterable<Uint8Array>,
    closed: new Promise<void>(() => {}),
    close() {},
  };

  return { channel, inject, sent };
}

/** Total bytes across every DATA frame the side sent for one stream id. */
function dataBytesForId(
  sent: { id: number; type: string; payload: Uint8Array }[],
  id: number,
): number {
  return sent
    .filter((f) => f.id === id && f.type === "DATA")
    .reduce((sum, f) => sum + f.payload.byteLength, 0);
}

describe("malformed credit frames do not poison the ledger", () => {
  // Regression coverage for the two `!== undefined` guards in emulate-mux.ts
  // (the OPEN-path advertisement and the ACK-path grant). Removing either
  // guard leaves the rest of the suite green: `undefined` reaches
  // `available += units`, the ledger becomes NaN, and the stream parks
  // forever — a silent, permanent stall, which is exactly the failure class
  // credit-based flow control exists to eliminate.
  //
  // The obvious test — inject the malformed frame and assert nothing is
  // sent — is vacuous: a guarded ledger stays at 0 and parks, an unguarded
  // one becomes NaN and parks, and both look identical from outside. The
  // distinguishing property is recoverability: `0 + n === n`, but
  // `NaN + n === NaN` forever. So each test below delivers the malformed
  // frame, THEN a valid one, and asserts the stream actually makes progress
  // afterwards — which only the guarded path can do.

  it("a payload-less OPEN is ignored, and a later valid ACK still lets the stream progress", async () => {
    const { channel, inject, sent } = injectionChannel();
    const server = emulateMux(channel, { side: "responder" });
    server.serve(async function* pushes() {
      // Ignores input entirely: the point is to observe the responder's own
      // outbound ledger (granted by the OPEN payload), not an echo.
      yield new Uint8Array(2048);
    });

    const id = 9;
    // Malformed OPEN: id + type only, no 4-byte advertisement. decodeUint32
    // returns undefined on this payload.
    inject(new Uint8Array([id, 0x01]));
    await new Promise((r) => setTimeout(r, 10));

    // Nothing made it out yet either way — 0 blocks exactly like NaN blocks.
    // This is setup, not the assertion: on its own it would pass whether or
    // not the guard exists.
    expect(dataBytesForId(sent, id)).toBe(0);

    // A later, valid grant on the same stream: a real 4-byte advertisement.
    inject(new Uint8Array([id, 0x03, 0x00, 0x00, 0x08, 0x00])); // ACK, 2048

    const deadline = Date.now() + 1000;
    while (dataBytesForId(sent, id) < 2048 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Guarded: ledger was 0, becomes 0 + 2048 = 2048, the parked reserve()
    // resolves, and the 2048-byte chunk goes out. Unguarded: the OPEN left
    // the ledger at NaN, and NaN + 2048 is still NaN — the waiter's
    // `available > 0` check never passes, so this never reaches 2048.
    expect(dataBytesForId(sent, id)).toBe(2048);

    await server.close();
  });

  it("a two-byte ACK is ignored, and a later valid ACK still lets the stream progress", async () => {
    const { channel, inject, sent } = injectionChannel();
    const client = emulateMux(channel, { side: "initiator" });

    const gen = client.call(
      (async function* () {
        yield new Uint8Array(2048);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* stream torn down by the deliberate mutation runs; fine here */
      }
    })();

    await new Promise((r) => setTimeout(r, 10));
    const open = sent.find((f) => f.type === "OPEN");
    expect(open).toBeDefined();
    const id = (open as { id: number }).id;

    // Nothing sent yet: the initiator's outbound ledger starts at 0 and no
    // grant has arrived.
    expect(dataBytesForId(sent, id)).toBe(0);

    // Malformed ACK: id + type only, no 4-byte grant.
    inject(new Uint8Array([id, 0x03]));
    await new Promise((r) => setTimeout(r, 10));

    // Still nothing — the same vacuous-looking state as the guarded case.
    expect(dataBytesForId(sent, id)).toBe(0);

    // A later, valid grant.
    inject(new Uint8Array([id, 0x03, 0x00, 0x00, 0x08, 0x00])); // ACK, 2048

    const deadline = Date.now() + 1000;
    while (dataBytesForId(sent, id) < 2048 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Guarded: the malformed ACK is dropped, the ledger stays at 0, and the
    // valid grant unparks it. Unguarded: the malformed ACK poisons the
    // ledger to NaN and the valid grant afterwards cannot revive it.
    expect(dataBytesForId(sent, id)).toBe(2048);

    await client.close();
  });
});
