import { describe, expect, it } from "vitest";
import { httpFetch, httpServe, type RequestEnvelope, type ResponseEnvelope } from "../src/index.js";

function loopback(): { a: MessagePort; b: MessagePort; close(): void } {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port2.start();
  return {
    a: port1,
    b: port2,
    close() {
      try {
        port1.close();
      } catch {}
      try {
        port2.close();
      } catch {}
    },
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const emptyRequest: RequestEnvelope = { url: "/x", method: "GET", headers: [] };

describe("httpFetch / httpServe", () => {
  it("GET round-trip with empty body", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = httpServe(b, async () => ({
        envelope: {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/plain"]],
        } satisfies ResponseEnvelope,
        body: (async function* () {
          yield new TextEncoder().encode("hello");
        })(),
      }));
      try {
        const res = await httpFetch(a, emptyRequest);
        expect(res.envelope.status).toBe(200);
        expect(res.envelope.headers).toEqual([["content-type", "text/plain"]]);
        expect(new TextDecoder().decode(await collect(res.body))).toBe("hello");
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  it("POST round-trip with body", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = httpServe(b, async (_env, body) => {
        const received = await collect(body);
        return {
          envelope: { status: 200, statusText: "OK", headers: [] },
          body: (async function* () {
            yield new Uint8Array([received.byteLength & 0xff]);
          })(),
        };
      });
      try {
        const reqBody = (async function* () {
          yield new Uint8Array([1, 2, 3]);
          yield new Uint8Array([4, 5]);
        })();
        const res = await httpFetch(a, { url: "/x", method: "POST", headers: [] }, reqBody);
        expect(Array.from(await collect(res.body))).toEqual([5]);
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  it("streaming response — 50 chunks", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = httpServe(b, async () => ({
        envelope: { status: 200, statusText: "OK", headers: [] },
        body: (async function* () {
          for (let i = 0; i < 50; i++) yield new Uint8Array([i]);
        })(),
      }));
      try {
        const res = await httpFetch(a, emptyRequest);
        const got = await collect(res.body);
        expect(got.byteLength).toBe(50);
        for (let i = 0; i < 50; i++) expect(got[i]).toBe(i);
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  it("multi-value Set-Cookie headers round-trip", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = httpServe(b, async () => ({
        envelope: {
          status: 200,
          statusText: "OK",
          headers: [
            ["Set-Cookie", "a=1"],
            ["Set-Cookie", "b=2"],
            ["content-type", "text/plain"],
          ],
        },
        body: (async function* () {})(),
      }));
      try {
        const res = await httpFetch(a, emptyRequest);
        expect(res.envelope.headers).toEqual([
          ["Set-Cookie", "a=1"],
          ["Set-Cookie", "b=2"],
          ["content-type", "text/plain"],
        ]);
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  it("10 concurrent calls — no cross-talk", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = httpServe(b, async (env) => {
        // Echo the URL back as the body.
        return {
          envelope: { status: 200, statusText: "OK", headers: [] },
          body: (async function* () {
            yield new TextEncoder().encode(env.url);
          })(),
        };
      });
      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, async (_, i) => {
            const res = await httpFetch(a, { url: `/u${i}`, method: "GET", headers: [] });
            return new TextDecoder().decode(await collect(res.body));
          }),
        );
        for (let i = 0; i < 10; i++) expect(results[i]).toBe(`/u${i}`);
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  // TODO (follow-up): wire callBidi's outer-callPort failure into the inner
  // ioSend so an abort or server-side error propagates to the body iterator.
  // Currently requires extending webrun-ports' bidi primitives.
  it.skip("AbortSignal pre-resolve — rejects with AbortError", async () => {
    const { a, b, close } = loopback();
    try {
      // Handler never resolves — keeps the call pending.
      const unsubscribe = httpServe(
        b,
        async () =>
          await new Promise<never>(() => {
            /* never resolves */
          }),
      );
      try {
        const ctrl = new AbortController();
        const promise = httpFetch(a, emptyRequest, undefined, { signal: ctrl.signal });
        setTimeout(() => ctrl.abort(), 30);
        await expect(promise).rejects.toThrow();
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });

  // TODO (follow-up): same callBidi limitation — server-side handler errors
  // surface as a "response:error" on the outer callPort, but the inner
  // ioSend recieveIterator stays pending.
  it.skip("handler throws before envelope — httpFetch rejects", async () => {
    const { a, b, close } = loopback();
    try {
      const unsubscribe = httpServe(b, async () => {
        throw new Error("handler boom");
      });
      try {
        await expect(httpFetch(a, emptyRequest)).rejects.toThrow();
      } finally {
        unsubscribe();
      }
    } finally {
      close();
    }
  });
});
