import { type ByteChannel, type Duplex, emulateMux } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { jsonEnvelopeCodec } from "../src/envelope.js";
import { PEER_ERROR_HEADER } from "../src/http-data.js";
import { httpCodec } from "../src/http1/index.js";
import { fetchOverDuplex, httpFetch, httpServe, serveFetchOverDuplex } from "../src/index.js";
import type { DecodedResponse, MessageCodec, RequestEnvelope } from "../src/message.js";

/** A pair of in-memory `ByteChannel`s piped to each other, for `emulateMux`. */
function makePipePair(): { a: ByteChannel; b: ByteChannel } {
  let closedResolveA!: () => void;
  let closedResolveB!: () => void;
  const closedA = new Promise<void>((r) => {
    closedResolveA = r;
  });
  const closedB = new Promise<void>((r) => {
    closedResolveB = r;
  });
  const queueA: Uint8Array[] = [];
  const queueB: Uint8Array[] = [];
  let pendingA: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let pendingB: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let closed = false;

  const deliverTo = (target: "a" | "b", bytes: Uint8Array): void => {
    if (closed) return;
    if (target === "a") {
      if (pendingA) {
        const r = pendingA;
        pendingA = null;
        r({ value: bytes, done: false });
      } else queueA.push(bytes);
    } else {
      if (pendingB) {
        const r = pendingB;
        pendingB = null;
        r({ value: bytes, done: false });
      } else queueB.push(bytes);
    }
  };

  const recvOf = (target: "a" | "b"): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          const queue = target === "a" ? queueA : queueB;
          if (queue.length > 0) {
            const value = queue.shift() as Uint8Array;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true } as IteratorResult<Uint8Array>);
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            if (target === "a") pendingA = resolve;
            else pendingB = resolve;
          });
        },
      };
    },
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    pendingA?.({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    pendingB?.({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    pendingA = null;
    pendingB = null;
    closedResolveA();
    closedResolveB();
  };

  return {
    a: { send: (bytes) => deliverTo("b", bytes), recv: recvOf("a"), closed: closedA, close },
    b: { send: (bytes) => deliverTo("a", bytes), recv: recvOf("b"), closed: closedB, close },
  };
}

const loopback =
  (handler: Duplex): Duplex =>
  (input) =>
    handler(input);

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of body) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("handler errors under HTTP framing", () => {
  it("still rejects on the caller, with the peer's message", async () => {
    const call = loopback(
      httpServe(async () => {
        throw new Error("boom");
      }),
    );
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toThrow(/boom/);
  });

  it("puts a conforming 500 on the wire, which a real peer could read", async () => {
    const call = loopback(
      httpServe(async () => {
        throw new Error("boom");
      }),
    );
    const wire = call(
      httpCodec.encodeRequest({ url: "http://h.test/x", method: "GET", headers: [] }),
    );
    const decoded = await httpCodec.decodeResponse(wire, { method: "GET" });
    expect(decoded.envelope.status).toBe(500);
    expect(decoded.envelope.statusText).toBe("Internal Server Error");
    expect(await text(decoded.body)).toContain("boom");
  });

  it("truncates a huge handler error message so the head still fits maxHeaderBytes (M3)", async () => {
    // A >64 KiB message must not blow the PEER_ERROR_HEADER header past
    // maxHeaderBytes: the client would then report "head section exceeds
    // 65536 bytes" instead of the peer's actual error, hiding it entirely.
    const hugeMessage = "x".repeat(100_000);
    const call = loopback(
      httpServe(async () => {
        throw new Error(hugeMessage);
      }),
    );
    const wire = call(
      httpCodec.encodeRequest({ url: "http://h.test/x", method: "GET", headers: [] }),
    );
    // decodeResponse itself would throw "head section exceeds 65536 bytes"
    // if the fix were missing; this must resolve.
    const decoded = await httpCodec.decodeResponse(wire, { method: "GET" });
    expect(decoded.envelope.status).toBe(500);
    const peerErrorHeader = decoded.envelope.headers.find(
      ([k]) => k.toLowerCase() === PEER_ERROR_HEADER,
    );
    expect(peerErrorHeader).toBeDefined();
    expect(peerErrorHeader?.[1].length).toBeLessThanOrEqual(4096);
  });

  it("preserves the error name across peers", async () => {
    const call = loopback(
      httpServe(async () => {
        const err = new Error("nope");
        err.name = "CustomError";
        throw err;
      }),
    );
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toMatchObject({ name: "CustomError", message: "nope" });
  });

  it("survives a non-ASCII error message", async () => {
    const call = loopback(
      httpServe(async () => {
        throw new Error("echec du a un probleme éàü");
      }),
    );
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toThrow(/éàü/);
  });

  it("propagates through the fetch layer too", async () => {
    const call = loopback(
      serveFetchOverDuplex(async () => {
        throw new Error("handler exploded");
      }),
    );
    await expect(fetchOverDuplex(call, new Request("https://example.test/x"))).rejects.toThrow(
      /handler exploded/,
    );
  });
});

describe("peer-error response body is actually drained", () => {
  it("runs the response body's own cleanup, not just .return() on a never-started generator", async () => {
    // A body whose `finally` marks itself released — proves `discard()` (used
    // by `throwIfPeerError`) actually started the generator before returning
    // it. `.return()` alone on a generator still in suspended start is a
    // documented JS no-op: none of the generator's code, including this
    // `finally`, would ever execute — which is exactly the bug under test.
    // A custom codec isolates this from HTTP/1.1's own chunked-decode
    // internals (a separate, lower-level concern from what `throwIfPeerError`
    // is responsible for): it hands `throwIfPeerError` a body it controls
    // directly, so this test is a property of `discard()` and its call site,
    // not of how any particular wire format happens to frame a body.
    const released = { value: false };
    async function* bodyWithFinally(): AsyncGenerator<Uint8Array> {
      try {
        yield new TextEncoder().encode("unused");
      } finally {
        released.value = true;
      }
    }

    const fakeCodec: MessageCodec = {
      name: "fake",
      sniff: () => true,
      encodeRequest: () => (async function* () {})(),
      encodeResponse: () => (async function* () {})(),
      decodeRequest: async () => ({
        envelope: { url: "/", method: "GET", headers: [] } as RequestEnvelope,
        body: (async function* () {})(),
      }),
      decodeResponse: async (): Promise<DecodedResponse> => ({
        envelope: {
          status: 500,
          statusText: "Internal Server Error",
          headers: [[PEER_ERROR_HEADER, JSON.stringify({ message: "boom" })]],
        },
        body: bodyWithFinally(),
      }),
    };

    const call: Duplex = () => (async function* () {})();
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }, undefined, {
        codec: fakeCodec,
      }),
    ).rejects.toThrow(/boom/);
    expect(released.value).toBe(true);
  });

  it("does not leak a mux stream slot per peer-error call", async () => {
    // On a mux transport, a `Duplex` call is backed by a stream-table entry
    // freed only when the consumer's output generator is driven to
    // completion or explicitly `.return()`-ed — see the comment on
    // `throwIfPeerError` in `src/http-data.ts`. Draining the response *body*
    // alone (the fix above) doesn't do that: the body is a separate,
    // lower-level generator that stops pulling from the wire as soon as it
    // has what it needs, well short of the `Duplex` call's own generator
    // reaching `{done: true}`. Left unreturned, each peer-error call leaks
    // one stream-table slot, forever, until the mux itself is closed — an
    // availability bug independent of body size.
    const { a, b } = makePipePair();
    const client = emulateMux(a, { side: "initiator", maxStreams: 2 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(
      httpServe(async () => {
        throw new Error("boom");
      }),
    );

    // Exhaust maxStreams worth of peer-error calls.
    for (let i = 0; i < 2; i++) {
      await expect(
        httpFetch(client.call, { url: "http://h.test/x", method: "GET", headers: [] }),
      ).rejects.toThrow(/boom/);
    }

    // A further call must still reach the peer (and get the real error),
    // not fail locally because every slot is still occupied by a call that
    // already finished.
    await expect(
      httpFetch(client.call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toThrow(/boom/);

    await client.close();
    await server.close();
  });

  it("does not let a failing output.return() mask the peer's error", async () => {
    // Same reasoning as discard()'s catch-and-swallow one line above: we are
    // about to throw the peer's own, more informative error. A transport
    // whose cancellation itself fails must not replace that with cleanup
    // noise ("transport close failed") — the cancellation is best-effort
    // bookkeeping, not something the caller asked for or should ever see.
    const fakeCodec: MessageCodec = {
      name: "fake",
      sniff: () => true,
      encodeRequest: () => (async function* () {})(),
      encodeResponse: () => (async function* () {})(),
      decodeRequest: async () => ({
        envelope: { url: "/", method: "GET", headers: [] } as RequestEnvelope,
        body: (async function* () {})(),
      }),
      decodeResponse: async (): Promise<DecodedResponse> => ({
        envelope: {
          status: 500,
          statusText: "Internal Server Error",
          headers: [[PEER_ERROR_HEADER, JSON.stringify({ message: "boom" })]],
        },
        body: (async function* () {
          yield new TextEncoder().encode("unused");
        })(),
      }),
    };

    const call: Duplex = () => {
      const output: AsyncGenerator<Uint8Array> = {
        async next(): Promise<IteratorResult<Uint8Array>> {
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          throw new Error("transport close failed");
        },
        async throw(err?: unknown): Promise<IteratorResult<Uint8Array>> {
          throw err;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return output;
    };

    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }, undefined, {
        codec: fakeCodec,
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("codec selection", () => {
  it("a client and server both pinned to the legacy codec interoperate", async () => {
    const call = loopback(
      httpServe(
        async () => ({
          envelope: { status: 200, statusText: "OK", headers: [] },
          body: [new TextEncoder().encode("legacy")],
        }),
        { codec: jsonEnvelopeCodec },
      ),
    );
    const { body } = await httpFetch(call, { url: "/x", method: "GET", headers: [] }, undefined, {
      codec: jsonEnvelopeCodec,
    });
    expect(await text(body)).toBe("legacy");
  });

  it("a legacy-pinned client reaches a default server and is answered in kind", async () => {
    const call = loopback(
      httpServe(async (env) => ({
        envelope: { status: 200, statusText: "OK", headers: [] },
        body: [new TextEncoder().encode(`saw ${env.method}`)],
      })),
    );
    const { body } = await httpFetch(call, { url: "/x", method: "GET", headers: [] }, undefined, {
      codec: jsonEnvelopeCodec,
    });
    expect(await text(body)).toBe("saw GET");
  });
});
