import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import {
  collect,
  collectBytes,
  collectString,
  decodeJsonl,
  decodeText,
  deserializeError,
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

describe("emulateMux is gone (Plan C3)", () => {
  it("is not exported: the port stack in webrun-rpc replaced it", () => {
    expect(api).not.toHaveProperty("emulateMux");
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

    // As the README writes it: the values come from an async generator.
    async function* records() {
      yield { a: 1 };
      yield { a: 2 };
    }
    const jsonl = encodeText(encodeJsonl(records()));
    expect(await collectString(decodeText(jsonl))).toBe('{"a":1}\n{"a":2}\n');

    // …and the round trip survives more than one value, which is what the
    // previously documented `decodeJsonl(splitLines(...))` form did not.
    const roundTrip = decodeJsonl<{ a: number }>(decodeText(encodeText(encodeJsonl(records()))));
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
