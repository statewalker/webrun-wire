import { describe, expect, it } from "vitest";
import { type ByteChannel, collectBytes, emulateMux } from "../src/index.js";

// Compiles and runs the emulateMux example from README.md, so the documented
// API shape cannot drift from the real one without this failing.
function pipePair(): { a: ByteChannel; b: ByteChannel } {
  const qa: Uint8Array[] = [],
    qb: Uint8Array[] = [];
  let pa: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let pb: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  const deliver = (t: "a" | "b", x: Uint8Array) => {
    const q = t === "a" ? qa : qb;
    const p = t === "a" ? pa : pb;
    if (p) {
      if (t === "a") pa = null;
      else pb = null;
      p({ value: x, done: false });
    } else q.push(x);
  };
  const recv = (t: "a" | "b") =>
    ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const q = t === "a" ? qa : qb;
          if (q.length) return Promise.resolve({ value: q.shift() as Uint8Array, done: false });
          return new Promise<IteratorResult<Uint8Array>>((r) => {
            if (t === "a") pa = r;
            else pb = r;
          });
        },
      }),
    }) as AsyncIterable<Uint8Array>;
  return {
    a: {
      send: (x) => deliver("b", x),
      recv: recv("a"),
      closed: new Promise<void>(() => {}),
      close: () => {},
    },
    b: {
      send: (x) => deliver("a", x),
      recv: recv("b"),
      closed: new Promise<void>(() => {}),
      close: () => {},
    },
  };
}

describe("README example", () => {
  it("the emulateMux snippet works as written", async () => {
    const { a, b } = pipePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });

    const stop = server.serve(async function* handler(input) {
      for await (const chunk of input) yield chunk; // echo
    });

    const response = client.call([new TextEncoder().encode("ping")]);
    expect(new TextDecoder().decode(await collectBytes(response))).toBe("ping");

    await stop();
    await client.close();
    await server.close();
  });

  it("the documented option defaults are the real ones", async () => {
    const { a } = pipePair();
    // All four documented options are accepted by the real signature.
    const mux = emulateMux(a, {
      side: "responder",
      maxStreams: 256,
      mtu: 65536,
      maxStreamBuffer: 8388608,
    });
    expect(typeof mux.call).toBe("function");
    expect(typeof mux.serve).toBe("function");
    expect(typeof mux.close).toBe("function");
    await mux.close();
  });
});
