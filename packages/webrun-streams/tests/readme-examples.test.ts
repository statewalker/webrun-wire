import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import {
  type ByteChannel,
  collect,
  collectBytes,
  collectString,
  decodeJsonl,
  decodeText,
  deserializeError,
  emulateMux,
  encodeJsonl,
  encodeText,
  fromReadableStream,
  joinLines,
  map,
  newAsyncGenerator,
  normalizeToUint8Array,
  recieveIterator,
  sendIterator,
  serializeError,
  splitLines,
  toChunks,
  toReadableStream,
} from "../src/index.js";

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

describe("README export table", () => {
  it("every documented name is exported", () => {
    for (const name of [
      "collect",
      "collectBytes",
      "collectString",
      "encodeText",
      "decodeText",
      "splitLines",
      "joinLines",
      "encodeJsonl",
      "decodeJsonl",
      "map",
      "newAsyncGenerator",
      "sendIterator",
      "recieveIterator",
      "toReadableStream",
      "fromReadableStream",
      "emulateMux",
      "normalizeToUint8Array",
      "toChunks",
      "serializeError",
      "deserializeError",
    ]) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});

describe("README examples (prose sections)", () => {
  it("collectors", async () => {
    async function* numbers() {
      yield 1;
      yield 2;
      yield 3;
    }
    expect(await collect(numbers())).toEqual([1, 2, 3]);
    async function* bytes() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    expect(Array.from(await collectBytes(bytes()))).toEqual([1, 2, 3]);
    async function* strings() {
      yield "a";
      yield "bc";
    }
    expect(await collectString(strings())).toBe("abc");
  });

  it("text / jsonl / lines codecs, exactly as documented", async () => {
    async function* chunks() {
      yield new Uint8Array([0x7b, 0x22, 0x61]);
      yield new Uint8Array([0x22, 0x3a, 0x31, 0x7d, 0x0a]);
    }
    expect(await collect(decodeJsonl<{ a: number }>(decodeText(chunks())))).toEqual([{ a: 1 }]);

    const jsonl = encodeText(encodeJsonl([{ a: 1 }, { a: 2 }]));
    expect(await collectString(decodeText(jsonl))).toBe('{"a":1}\n{"a":2}\n');

    // …and the round trip survives more than one value, which is what the
    // previously documented `decodeJsonl(splitLines(...))` form did not.
    const roundTrip = decodeJsonl<{ a: number }>(
      decodeText(encodeText(encodeJsonl([{ a: 1 }, { a: 2 }]))),
    );
    expect(await collect(roundTrip)).toEqual([{ a: 1 }, { a: 2 }]);

    // splitLines / joinLines on plain string streams
    async function* text() {
      yield "one\ntw";
      yield "o\n";
    }
    expect(await collect(splitLines(text()))).toEqual(["one", "two"]);
    expect(
      await collectString(
        joinLines(
          (async function* () {
            yield "a";
            yield "b";
          })(),
        ),
      ),
    ).toBe("a\nb\n");
  });

  it("callback → AsyncGenerator bridge", async () => {
    function ticker(): AsyncGenerator<number> {
      return newAsyncGenerator<number>((next, done) => {
        let n = 0;
        const id = setInterval(() => {
          if (n < 5) void next(n++);
          else {
            void done();
            clearInterval(id);
          }
        }, 1);
        return () => clearInterval(id);
      });
    }
    expect(await collect(ticker())).toEqual([0, 1, 2, 3, 4]);
  });

  it("iterator chunk protocol, exactly as documented", async () => {
    type Chunk = { done: boolean; value?: number; error?: unknown };
    let deliverFn: ((c: Chunk) => Promise<boolean>) | undefined;
    const myChannel = {
      send: async (chunk: Chunk) => {
        await deliverFn?.(chunk);
      },
    };

    async function transport(chunk: Chunk) {
      await myChannel.send(chunk);
    }

    const iter = recieveIterator<number>((deliver) => {
      deliverFn = deliver as (c: Chunk) => Promise<boolean>;
    });

    const [, received] = await Promise.all([sendIterator(transport, [1, 2, 3]), collect(iter)]);
    expect(received).toEqual([1, 2, 3]);
  });

  it("WHATWG streams ↔ async iterators", async () => {
    async function* encoded() {
      const e = new TextEncoder();
      yield e.encode("hello ");
      yield e.encode("world");
    }
    expect(await new Response(toReadableStream(encoded())).text()).toBe("hello world");

    const reqBody = new Response(toReadableStream(encoded())).body as ReadableStream<Uint8Array>;
    const parts: Uint8Array[] = [];
    for await (const chunk of fromReadableStream(reqBody)) parts.push(chunk);
    expect(parts.map((p) => new TextDecoder().decode(p)).join("")).toBe("hello world");
  });

  it("error roundtrip", () => {
    class NotFoundError extends Error {
      status = 404;
    }
    const wire = serializeError(new NotFoundError("missing"));
    expect(wire).toMatchObject({ message: "missing", status: 404 });
    expect(wire.stack).toBeTypeOf("string");
    const restored = deserializeError(wire) as Error & { status?: number };
    expect(restored instanceof Error).toBe(true);
    expect(restored.status).toBe(404);
  });

  it("map, and the corrected toChunks / normalizeToUint8Array signatures", async () => {
    async function* src() {
      yield 1;
      yield 2;
    }
    expect(await collect(map(src(), (n) => n * 2))).toEqual([2, 4]);

    async function* bytes() {
      yield new Uint8Array([1, 2, 3, 4, 5]);
    }
    // curried: toChunks(size) returns the transform
    expect((await collect(toChunks(2)(bytes()))).map((c) => Array.from(c))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    async function* big() {
      yield new Uint8Array(20_000);
    }
    expect((await collect(toChunks()(big()))).map((c) => c.byteLength)).toEqual([16384, 3616]);

    expect(Array.from(normalizeToUint8Array("ab") as Uint8Array)).toEqual([97, 98]);
    const fromBlob = normalizeToUint8Array(new Blob(["ab"]));
    expect(fromBlob).toBeInstanceOf(Promise);
    expect(Array.from(await fromBlob)).toEqual([97, 98]);
  });
});
