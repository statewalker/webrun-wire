import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { duplexOverPort, STREAM_ABORT, serveDuplexOverPort } from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Polls `predicate` instead of waiting a fixed number of ticks — a fixed
 * delay is a race (it usually wins under light load and loses under a
 * heavier one), while polling the actual condition removes the race. `label`
 * names what's being waited for so a timeout points straight at the cause.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A caller/handler pair over one real MessageChannel — one stream, one port. */
function streamPair(handler: Duplex, options: { maxMessageSize?: number } = {}) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const off = serveDuplexOverPort(channel.port2, handler, options);
  const call = duplexOverPort(channel.port1, options);
  return {
    call,
    close() {
      off();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const echo: Duplex = async function* echo(input) {
  for await (const chunk of input) yield chunk;
};

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const p of open.splice(0)) p.close();
});

function pair(handler: Duplex, options: { maxMessageSize?: number } = {}) {
  const p = streamPair(handler, options);
  open.push(p);
  return p;
}

describe("duplexOverPort — data path", () => {
  it("round-trips a small body through an echo handler", async () => {
    const { call } = pair(echo);
    const out = await collectBytes(call([enc.encode("hello stream")]));
    expect(dec.decode(out)).toBe("hello stream");
  });

  it("round-trips an empty body", async () => {
    const { call } = pair(echo);
    const out = await collectBytes(call([new Uint8Array(0)]));
    expect(out.byteLength).toBe(0);
  });

  it("splits a body larger than maxMessageSize and reassembles it intact", async () => {
    // R3: the LiveKit failure this guards against delivered a 1 MiB body as
    // zero bytes with no error on either side. The count assertion is the
    // ceiling; byteLength and the content check are its floor.
    const seen: number[] = [];
    const counting: Duplex = async function* counting(input) {
      for await (const chunk of input) {
        seen.push(chunk.byteLength);
        yield chunk;
      }
    };
    const size = 100 * 1024;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i & 0xff;

    const { call } = pair(counting, { maxMessageSize: 4096 });
    const out = await collectBytes(call([body]));

    expect(out.byteLength).toBe(size);
    expect(out[0]).toBe(0);
    expect(out[size - 1]).toBe((size - 1) & 0xff);
    expect(seen.length).toBe(Math.ceil(size / 4096));
    expect(Math.max(...seen)).toBeLessThanOrEqual(4096);
  });

  it("keeps yielding after the caller's input exhausts (half-close)", async () => {
    const lateResponder: Duplex = async function* lateResponder(input) {
      for await (const _ of input) {
        /* drain */
      }
      yield enc.encode("a");
      await new Promise((r) => setTimeout(r, 30));
      yield enc.encode("b");
      await new Promise((r) => setTimeout(r, 30));
      yield enc.encode("c");
    };
    const { call } = pair(lateResponder);
    const out = await collectBytes(
      call(
        (async function* () {
          yield enc.encode("ping");
        })(),
      ),
    );
    expect(dec.decode(out)).toBe("abc");
  });

  it("carries a handler error across the wire with its custom fields and stack", async () => {
    const failing: Duplex = async function* failing() {
      const err = new Error("intentional failure");
      Object.assign(err, { status: 418, code: "TEAPOT" });
      if ((0 as number) === 0) throw err;
      yield new Uint8Array(0);
    };
    const { call } = pair(failing);
    let caught: unknown;
    try {
      await collectBytes(call([new Uint8Array(0)]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      message: "intentional failure",
      status: 418,
      code: "TEAPOT",
    });
    expect(typeof (caught as Error).stack).toBe("string");
    expect(((caught as Error).stack ?? "").length).toBeGreaterThan(0);
  });

  it("carries a caller-side input error to the handler", async () => {
    let handlerSaw: unknown;
    const catching: Duplex = async function* catching(input) {
      try {
        for await (const _ of input) {
          /* drain */
        }
      } catch (e) {
        handlerSaw = e;
      }
      yield enc.encode("done");
    };
    const { call } = pair(catching);
    const out = await collectBytes(
      call(
        (async function* () {
          yield enc.encode("one");
          const err = new Error("producer blew up");
          Object.assign(err, { code: "PRODUCER" });
          throw err;
        })(),
      ),
    );
    expect(dec.decode(out)).toBe("done");
    expect(handlerSaw).toMatchObject({ message: "producer blew up", code: "PRODUCER" });
  });
});

describe("duplexOverPort — abort ordering (fix round 1 regression)", () => {
  // `receiveChunks` used to deliver an abort to the consumer only via a
  // `deliver` callback that `recieveIterator`'s installer assigns lazily, on
  // the consumer's first `.next()`. If the abort fired before that first
  // pull, `deliver` was still `undefined`, the delivery was a silent no-op,
  // and the consumer hung forever once it did start iterating — with no
  // timeout backstop (Task 4's per-stream timeout defaults to none). Both
  // orderings are covered here because having only one is how this survived
  // review the first time.

  it("settles when the peer's abort notice arrives before the handler ever reads its input", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    open.push({
      close() {
        channel.port1.close();
        channel.port2.close();
      },
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let settled = false;
    let settledError: unknown;

    // Never touches `input` until the test releases the gate below, so the
    // consumer's first `.next()` — and therefore `recieveIterator`'s
    // installer — cannot have run yet when the abort notice is posted.
    const gatedDrain: Duplex = async function* gatedDrain(input) {
      await gate;
      try {
        for await (const _ of input) {
          /* drain, if anything ever arrives */
        }
      } catch (e) {
        settledError = e;
      } finally {
        settled = true;
      }
      yield enc.encode("done");
    };

    const off = serveDuplexOverPort(channel.port2, gatedDrain);
    open.push({ close: off });

    // An extra listener on the same port, added after
    // `serveDuplexOverPort`'s own. Listeners added via `addEventListener`
    // for the same event fire synchronously in registration order, so
    // seeing this fire proves the internal `installAbortNotice` listener
    // (registered first) has already processed the notice and aborted the
    // controller — i.e. the abort has already happened, and the handler
    // still hasn't pulled anything, before we release the gate.
    let noticeSeenAtHandler = false;
    const onRaw = (event: MessageEvent) => {
      if ((event.data as { type?: unknown })?.type === STREAM_ABORT) noticeSeenAtHandler = true;
    };
    channel.port2.addEventListener("message", onRaw);

    channel.port1.postMessage({ type: STREAM_ABORT });
    await waitFor(() => noticeSeenAtHandler, "the handler's port received the abort notice");
    channel.port2.removeEventListener("message", onRaw);

    release();

    // Floor: this must actually settle, not merely "not throw synchronously".
    await waitFor(
      () => settled,
      "the handler's for-await settles instead of hanging after an early abort",
      2000,
    );
    expect(settledError).toBeInstanceOf(Error);
    expect((settledError as Error).message).toMatch(/abandoned the stream/);
  }, 3000);

  it("also settles when the abort arrives while the consumer is already parked awaiting the next chunk (floor)", async () => {
    // A fix that only handles the early-abort ordering above must not
    // silently break the ordering that already worked: abort arriving
    // after the consumer has started iterating.
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    open.push({
      close() {
        channel.port1.close();
        channel.port2.close();
      },
    });

    let settled = false;
    let settledError: unknown;

    // No gate: the handler starts draining `input` immediately. The pull
    // chain (serveDuplexOverPort -> sendChunks -> sendIterator -> the
    // handler's generator -> `input`'s `for await`) runs synchronously
    // down to `input`'s first `.next()` before `serveDuplexOverPort`
    // returns, so `recieveIterator`'s installer — and therefore `deliver`
    // — is already wired up by the time this function returns, well
    // before the abort notice below is even posted.
    const drain: Duplex = async function* drain(input) {
      try {
        for await (const _ of input) {
          /* never arrives in this test */
        }
      } catch (e) {
        settledError = e;
      } finally {
        settled = true;
      }
      yield enc.encode("done");
    };

    const off = serveDuplexOverPort(channel.port2, drain);
    open.push({ close: off });

    channel.port1.postMessage({ type: STREAM_ABORT });

    await waitFor(
      () => settled,
      "the already-iterating handler still settles on a later abort",
      2000,
    );
    expect(settledError).toBeInstanceOf(Error);
    expect((settledError as Error).message).toMatch(/abandoned the stream/);
  }, 3000);
});
