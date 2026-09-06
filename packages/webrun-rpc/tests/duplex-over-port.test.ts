import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { duplexOverPort, serveDuplexOverPort } from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

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
