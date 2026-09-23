/**
 * The unit tests of msgpack.js, ported to TypeScript and vitest.
 *
 * Source: https://github.com/ygoe/msgpack.js/blob/05733cfb43a2974cf669f0eb8693f43b548bdcd4/msgpack-tests.js
 * Copyright © 2019, Yves Goergen — MIT license, see src/msgpack-core.ts.
 *
 * Upstream runs these in a browser page and compares a printed form of the value before and after a
 * round trip; here each case asserts the round trip directly. The cases, and their order, are
 * upstream's. Where the port had to make an upstream expectation explicit, the comment says so.
 * The benchmark against msgpack-lite is not ported.
 */
import { describe, expect, it } from "vitest";
import { deserialize, type SerializeOptions, serialize } from "../src/msgpack-core.js";

function roundTrip(data: unknown, options?: SerializeOptions): unknown {
  return deserialize(serialize(data, options));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

describe("msgpack.js upstream tests: testData()", () => {
  const numbers = [
    -65,
    -11114294967299,
    4294967298,
    2 ** 53 - 1,
    2 ** 53,
    2 ** 100,
    -(2 ** 53 - 1),
    -(2 ** 53),
    -(2 ** 100),
  ];
  for (const value of numbers) {
    it(`round-trips ${value}`, () => {
      expect(roundTrip(value)).toBe(value);
    });
  }

  // Upstream builds these dates in local time; the instant is what is compared.
  const dates = [
    new Date(2001, 1 /*Feb*/, 3, 4, 5, 6),
    new Date(2110, 1 /*Feb*/, 3, 4, 5, 6),
    new Date(0x3ffffffff * 1000 + 50),
    new Date(0xfffffffff * 1000 + 50),
    new Date(-1),
  ];
  for (const value of dates) {
    it(`round-trips the date ${value.toISOString()}`, () => {
      const result = roundTrip(value);
      expect(result).toBeInstanceOf(Date);
      expect((result as Date).getTime()).toBe(value.getTime());
    });
  }

  it("round-trips a Uint8Array as bin", () => {
    const result = roundTrip(new Uint8Array([1, 2, 3, 200]));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3, 200]);
  });

  it("honours byteOffset when reading a float from a subarray (testByteOffset)", () => {
    const buf = new ArrayBuffer(10);
    const arr0 = new Uint8Array(buf);
    const arr1 = new Uint8Array(buf, 1);
    arr0.fill(255);
    arr1.fill(0);
    arr1[0] = 0xcb;
    // If the offset were ignored, the float would be read from the 0xff bytes at index 0.
    expect(deserialize(arr1)).toBe(0);
  });

  it("serializes and deserializes multiple concatenated values (testArrayData)", () => {
    const data = [9, "Abc", { a: true, b: new Uint8Array([1, 2, 4]) }];
    // Upstream passes the bare `true` as the options argument, which reads `true.multiple` and
    // so never takes the multiple path; the options object is what the API documents.
    const bin = serialize(data, { multiple: true });
    // Three documents, not one array: the first byte is the fixint 9, not a fixarray header.
    expect(bin[0]).toBe(9);
    const result = deserialize(bin, { multiple: true }) as unknown[];
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(9);
    expect(result[1]).toBe("Abc");
    const third = result[2] as { a: boolean; b: Uint8Array };
    expect(third.a).toBe(true);
    expect(Array.from(third.b)).toEqual([1, 2, 4]);
  });

  it('turns a function into "f" with a replacement value', () => {
    expect(roundTrip(() => {}, { invalidTypeReplacement: "f" })).toBe("f");
  });

  it('turns a function into "function" with a replacement function', () => {
    expect(roundTrip(() => {}, { invalidTypeReplacement: (v: unknown) => typeof v })).toBe(
      "function",
    );
  });

  it("encodes a non-byte typed array as an array of numbers (upstream: 'Expected to fail')", () => {
    // Upstream lists this under "Expected to fail": the round trip does not give back the
    // Uint32Array, because only Uint8Array and Uint8ClampedArray travel as bin.
    const result = roundTrip(new Uint32Array([1, 2, 3, 200000]));
    expect(result).not.toBeInstanceOf(Uint32Array);
    expect(result).toEqual([1, 2, 3, 200000]);
  });

  it("throws for a function without a replacement (upstream: 'Expected to throw an error')", () => {
    expect(() => serialize(() => {})).toThrow("The type 'function' cannot be serialized");
  });
});

describe("msgpack.js upstream tests: the fixes on master after 1.0.3", () => {
  // Commit 05733cf (#32) added the uint64 cases above; these pin the bytes each fix changed, since
  // a round trip alone passes on the old code too.
  it("writes a positive integer above uint32 with the uint64 prefix 0xcf (#32)", () => {
    expect(hex(serialize(4294967298))).toBe("cf 00 00 00 01 00 00 00 02");
  });

  it("writes an integer beyond the safe range as a float64 (#34)", () => {
    expect(hex(serialize(2 ** 100))).toBe(
      hex(Uint8Array.from([0xcb, 0x46, 0x30, 0, 0, 0, 0, 0, 0])),
    );
  });

  it("writes a 16..255-byte bin with the one-byte bin 8 header (#33)", () => {
    const bytes = serialize(new Uint8Array(16));
    expect(bytes[0]).toBe(0xc4);
    expect(bytes[1]).toBe(16);
    expect(bytes.length).toBe(18);
  });
});
