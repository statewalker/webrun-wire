import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  connect,
  multiplexPort,
  type PortEnvelope,
  STREAM_ABORT,
  serve,
  structuredCodec,
} from "../src/index.js";

// Where both ends agree `end`, a stream that ends normally in both directions
// ends each direction with `end` instead of a `close`, and the id is freed on
// both ends by the two ends alone. A stream that does not end normally is
// abandoned: the abort notice, then `close`.

const KiB = 1024;
const WINDOW = 64 * KiB;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An envelope as it crossed the pipe; `from` says which end posted it. */
type Seen = { from: "caller" | "server"; envelope: PortEnvelope };

/**
 * `connect` / `serve` over one `MessageChannel`, with `window` on both ends
 * (`0`: none).
 * Every envelope is logged as it arrives, and both muxes are kept for
 * `ports()`.
 */
async function link(handler: Duplex, window = WINDOW) {
  const ch = new MessageChannel();
  const wire: Seen[] = [];
  ch.port1.addEventListener("message", (e) => {
    const envelope = structuredCodec.read(e);
    if (envelope) wire.push({ from: "server", envelope });
  });
  ch.port2.addEventListener("message", (e) => {
    const envelope = structuredCodec.read(e);
    if (envelope) wire.push({ from: "caller", envelope });
  });
  let server: ReturnType<typeof multiplexPort> | undefined;
  let client: ReturnType<typeof multiplexPort> | undefined;
  const teardown = await serve(
    {
      mux: (onPort) => {
        server = multiplexPort(ch.port2, {
          codec: structuredCodec,
          side: "responder",
          window,
          onPort,
        });
        return server;
      },
    },
    handler,
  );
  const { call, close } = await connect({
    mux: (onPort) => {
      client = multiplexPort(ch.port1, {
        codec: structuredCodec,
        side: "initiator",
        window,
        onPort,
      });
      return client;
    },
  });
  cleanups.push(async () => {
    await close();
    await teardown();
    ch.port1.close();
    ch.port2.close();
  });
  // biome-ignore lint/style/noNonNullAssertion: both factories ran above.
  const muxes = { client: client!, server: server! };
  const types = (from: Seen["from"]) =>
    wire.filter((s) => s.from === from && s.envelope.type !== "credit").map((s) => s.envelope.type);
  const notices = (from: Seen["from"]) =>
    wire.filter(
      (s) =>
        s.from === from &&
        s.envelope.type === "message" &&
        (s.envelope.payload as { type?: unknown } | undefined)?.type === STREAM_ABORT,
    ).length;
  const replies = (from: Seen["from"]) =>
    wire.filter(
      (s) =>
        s.from === from &&
        s.envelope.type === "message" &&
        (s.envelope.payload as { type?: unknown } | undefined)?.type === "response:result",
    ).length;
  const freed = () => muxes.client.ports().length === 0 && muxes.server.ports().length === 0;
  return { call, wire, types, notices, replies, freed, muxes };
}

/** Reads a stream to its end: the chunks' bytes, and the error it ended with. */
async function drain(stream: AsyncIterable<Uint8Array>) {
  const seen: number[] = [];
  let error: unknown;
  try {
    for await (const chunk of stream) seen.push(...chunk);
  } catch (err) {
    error = err;
  }
  return { seen, error };
}

describe("duplexOverPort — a stream that ends normally ends its port", () => {
  it("frees the id on both ends, with an end each way and no close on the wire", async () => {
    let handlerError: unknown;
    let handlerDone = false;
    const echo: Duplex = async function* (input) {
      try {
        for await (const chunk of input) yield chunk;
      } catch (err) {
        handlerError = err;
        throw err;
      } finally {
        handlerDone = true;
      }
    };
    const s = await link(echo);
    // More than the window, so credit has to flow and chunks are pipelined.
    const input = Array.from({ length: 100 }, (_, i) => new Uint8Array(1000).fill(i & 0xff));
    const { seen, error } = await drain(s.call(input));
    expect(error).toBeUndefined();
    expect(seen).toEqual(input.flatMap((c) => [...c]));

    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller").filter((t) => t === "end")).toHaveLength(1);
    expect(s.types("server").filter((t) => t === "end")).toHaveLength(1);
    expect(s.types("caller")).not.toContain("close");
    expect(s.types("server")).not.toContain("close");
    // Nothing follows an end from the same side.
    expect(s.types("caller").at(-1)).toBe("end");
    expect(s.types("server").at(-1)).toBe("end");
    expect(s.notices("caller") + s.notices("server")).toBe(0);
    // Freeing the port is not an error anywhere.
    await waitFor("the handler settled", () => handlerDone);
    expect(handlerError).toBeUndefined();
  });

  it("ends an empty stream whose ends were confirmed before the handshake settled", async () => {
    // The caller's end-of-input leaves with the `open`, before the ack, and the
    // handler answers before the opener's answer to the ack: both `done`
    // chunks are confirmed calls. Each confirmation must leave before the end
    // of the side that sends it, or the peer's call would never settle.
    const s = await link(async function* (input) {
      for await (const _ of input) {
      }
      yield* [];
    });
    const { seen, error } = await drain(s.call([]));
    expect(error).toBeUndefined();
    expect(seen).toEqual([]);
    await waitFor("both ends freed the port", s.freed);
    expect(s.replies("caller")).toBe(1);
    expect(s.replies("server")).toBe(1);
    expect(s.types("caller")).not.toContain("close");
    expect(s.types("server")).not.toContain("close");
    expect(s.types("caller").at(-1)).toBe("end");
    expect(s.types("server").at(-1)).toBe("end");
  });

  it("ends a stream whose handler finished without reading all of its input", async () => {
    // The caller's input is all sent, pipelined, before the handler answers;
    // the handler never reads it. The caller's end is then what tells the
    // serving side that no more input is coming.
    let wire: Seen[] = [];
    const payload = (seen: Seen) =>
      seen.envelope.type === "message"
        ? (seen.envelope.payload as { type?: string; chunk?: { done?: boolean } })
        : undefined;
    const s = await link(async function* () {
      await waitFor("the caller's last chunk, pipelined", () =>
        wire.some(
          (w) =>
            w.from === "caller" &&
            payload(w)?.type === "webrun-rpc:chunk" &&
            payload(w)?.chunk?.done,
        ),
      );
      yield new Uint8Array([1]);
    });
    wire = s.wire;
    async function* input() {
      // Pipelined once the ack has agreed it.
      await waitFor("the ack", () =>
        wire.some((w) => w.from === "server" && w.envelope.type === "credit" && w.envelope.caps),
      );
      for (let i = 0; i < 3; i++) yield new Uint8Array(100).fill(i);
    }
    const { seen, error } = await drain(s.call(input()));
    expect(error).toBeUndefined();
    expect(seen).toEqual([1]);
    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller")).not.toContain("close");
    expect(s.types("server")).not.toContain("close");
    expect(s.types("server").at(-1)).toBe("end");
  });

  it("several streams in a row each free their own port", async () => {
    const echo: Duplex = async function* (input) {
      for await (const chunk of input) yield chunk;
    };
    const s = await link(echo);
    for (let i = 0; i < 5; i++) {
      const { seen } = await drain(s.call([new Uint8Array([i])]));
      expect(seen).toEqual([i]);
    }
    await waitFor("both ends freed every port", s.freed);
    expect(s.types("caller").filter((t) => t === "end")).toHaveLength(5);
    expect(s.types("server").filter((t) => t === "end")).toHaveLength(5);
    expect(s.types("caller")).not.toContain("close");
  });
});

describe("duplexOverPort — a stream that does not end normally posts its notice and closes", () => {
  it("a handler's error: the caller notifies and closes, and nobody sends end", async () => {
    const s = await link(async function* (input) {
      for await (const _ of input) {
      }
      yield new Uint8Array([1]);
      throw new Error("boom");
    });
    const { seen, error } = await drain(s.call([new Uint8Array([0])]));
    expect(seen).toEqual([1]);
    expect((error as Error).message).toBe("boom");
    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller")).toContain("close");
    expect(s.notices("caller")).toBe(1);
    expect(s.types("caller")).not.toContain("end");
    expect(s.types("server")).not.toContain("end");
  });

  it("a handler's error as its first chunk, confirmed: closed the same way", async () => {
    // Before the opener answers the ack, the handler's chunks are confirmed
    // calls: its error is then confirmed too, and must not count as a finish.
    const s = await link(async function* (input) {
      for await (const _ of input) {
      }
      yield* [];
      throw new Error("boom at once");
    });
    const { error } = await drain(s.call([]));
    expect((error as Error).message).toBe("boom at once");
    await waitFor("both ends freed the port", s.freed);
    expect(s.replies("caller")).toBe(1);
    expect(s.types("caller")).toContain("close");
    expect(s.notices("caller")).toBe(1);
    expect(s.types("caller")).not.toContain("end");
    expect(s.types("server")).not.toContain("end");
  });

  it("a caller that returns early notifies and closes, and nobody sends end", async () => {
    const s = await link(async function* () {
      while (true) {
        yield new Uint8Array([1]);
        await sleep(5);
      }
    });
    let n = 0;
    for await (const _ of s.call([new Uint8Array(0)])) {
      if (++n >= 3) break;
    }
    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller")).toContain("close");
    expect(s.notices("caller")).toBe(1);
    expect(s.types("caller")).not.toContain("end");
    expect(s.types("server")).not.toContain("end");
  });

  it("a caller's input that fails: the caller notifies and closes, and nobody sends end", async () => {
    // The handler takes the failure in its stride and finishes normally: its
    // input still did not end normally, so its side does not end either.
    const s = await link(async function* (input) {
      try {
        for await (const chunk of input) yield chunk;
      } catch {}
    });
    async function* failing() {
      yield new Uint8Array([1]);
      throw new Error("input broke");
    }
    const { error } = await drain(s.call(failing()));
    expect(error).toBeUndefined();
    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller")).toContain("close");
    expect(s.types("caller")).not.toContain("end");
    expect(s.types("server")).not.toContain("end");
  });

  it("a confirmed chunk the handler never read: the stream closes, and nothing leaks", async () => {
    // The end of input leaves with the `open`, a confirmed call; a handler that
    // returns without reading never confirms it, so the caller's side never
    // ended normally.
    const s = await link(async function* () {
      yield new Uint8Array([1]);
    });
    const { seen, error } = await drain(s.call([]));
    expect(error).toBeUndefined();
    expect(seen).toEqual([1]);
    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller")).toContain("close");
    expect(s.notices("caller")).toBe(1);
    expect(s.types("caller")).not.toContain("end");
  });

  it("without a window, a normal stream posts its notice and closes", async () => {
    const s = await link(async function* (input) {
      for await (const chunk of input) yield chunk;
    }, 0);
    const { seen } = await drain(s.call([new Uint8Array([3])]));
    expect(seen).toEqual([3]);
    await waitFor("both ends freed the port", s.freed);
    expect(s.types("caller")).toContain("close");
    expect(s.notices("caller")).toBe(1);
    expect(s.types("caller")).not.toContain("end");
    expect(s.types("server")).not.toContain("end");
  });
});
