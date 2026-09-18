/**
 * The language-neutral MessagePack conformance set, run against `serialize`/`deserialize`.
 *
 * Fixture: https://github.com/kawanet/msgpack-test-suite (MIT, © 2017-2018 Yusuke Kawasaki),
 * vendored at tests/fixtures/msgpack-test-suite/. Every entry is a value together with every
 * encoding of it that is valid MessagePack: a decoder must accept all of them, and an encoder must
 * produce one of them.
 *
 * The second half ports the cases msgpack-javascript adds because the suite does not reach them
 * (https://github.com/msgpack/msgpack-javascript/blob/6d4b666f061e49d5cccab88d266cf6cf1b96bbbf/test/msgpack-test-suite.test.ts,
 * ISC, © 2019 The MessagePack Community).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "../src/msgpack-core.js";

type Entry = { msgpack: string[] } & Record<string, unknown>;
type Suite = Record<string, Entry[]>;

const suite = JSON.parse(
  readFileSync(
    new URL("./fixtures/msgpack-test-suite/msgpack-test-suite.json", import.meta.url),
    "utf8",
  ),
) as Suite;

function fromHex(hex: string): Uint8Array {
  if (hex === "") return new Uint8Array(0);
  return Uint8Array.from(hex.split("-"), (b) => Number.parseInt(b, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("-");
}

/** The entry's value key: every entry has `msgpack` plus one of these (bignum sits beside number). */
const KINDS = [
  "nil",
  "bool",
  "binary",
  "number",
  "bignum",
  "string",
  "array",
  "map",
  "timestamp",
  "ext",
];

function kindOf(entry: Entry): string {
  const kind = KINDS.find((k) => k in entry);
  if (!kind) throw new Error(`unrecognised entry: ${JSON.stringify(entry)}`);
  return kind;
}

/** What `deserialize` must return for the entry, in this implementation's value model. */
function expected(entry: Entry): unknown {
  const kind = kindOf(entry);
  const value = entry[kind];
  switch (kind) {
    case "binary":
      return fromHex(value as string);
    case "bignum":
      // Only the 64-bit values JSON cannot hold have no `number`: a JS number gets the nearest
      // double, exactly as `Number()` rounds the decimal string.
      return Number(value as string);
    case "timestamp": {
      // A Date holds milliseconds: the instant is floored to the millisecond it falls in.
      const [sec, nsec] = value as [number, number];
      return new Date(sec * 1000 + Math.floor(nsec / 1e6));
    }
    case "ext": {
      const [type, data] = value as [number, string];
      return { type, data: fromHex(data) };
    }
    default:
      return value;
  }
}

/** Whether a JS value can carry the entry exactly, so that encoding it is a meaningful check. */
function encodable(entry: Entry): unknown {
  const kind = kindOf(entry);
  if (kind === "ext" || kind === "bignum") return undefined; // no JS value encodes to these
  if (kind === "timestamp") {
    const [, nsec] = entry.timestamp as [number, number];
    if (nsec % 1e6 !== 0) return undefined; // below a millisecond: a Date cannot hold it
  }
  return expected(entry);
}

function title(entry: Entry): string {
  const kind = kindOf(entry);
  const text = JSON.stringify(entry[kind]);
  return `${kind} ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
}

for (const [file, entries] of Object.entries(suite)) {
  describe(`msgpack-test-suite ${file}`, () => {
    for (const entry of entries) {
      it(`decodes every encoding of ${title(entry)}`, () => {
        for (const hex of entry.msgpack) {
          const value = deserialize(fromHex(hex));
          expect(value, hex).toEqual(expected(entry));
        }
      });

      const value = encodable(entry);
      if (value !== undefined) {
        it(`encodes ${title(entry)} as one of its valid encodings`, () => {
          expect(entry.msgpack).toContain(toHex(serialize(value)));
        });
      }
    }
  });
}

describe("msgpack-javascript: specs the test suite does not cover", () => {
  const SPECS: Record<string, unknown> = {
    FLOAT64_POSITIVE_INF: Number.POSITIVE_INFINITY,
    FLOAT64_NEGATIVE_INF: Number.NEGATIVE_INFINITY,
    FLOAT64_NAN: Number.NaN,
    STR16: "a".repeat(0x100),
    STR16_MBS: "🌏".repeat(0x100),
    STR32: "b".repeat(0x10_000),
    STR32_MBS: "🍣".repeat(0x10_000),
    // may cause "RangeError: Maximum call stack size exceeded" in simple implementations
    STR32LARGE: "c".repeat(0x50_000),
    STR_INCLUDING_NUL: "foo\0bar\0",
    STR_BROKEN_FF: "\xff",
    BIN16: new Uint8Array(0x100).fill(0xff),
    BIN32: new Uint8Array(0x10_000).fill(0xff),
    // regression upstream: caused "RangeError: Maximum call stack size exceeded"
    BIN32LARGE: new Uint8Array(0x50_000).fill(0xff),
    ARRAY16: new Array<boolean>(0x100).fill(true),
    ARRAY32: new Array<boolean>(0x10000).fill(true),
    MAP16: Object.fromEntries(Array.from({ length: 0x100 }, (_, i) => [`k${i}`, i])),
    MAP32: Object.fromEntries(Array.from({ length: 0x10000 }, (_, i) => [`k${i}`, i])),
    MIXED: new Array(0x10).fill(Number.MAX_SAFE_INTEGER),
  };

  for (const [name, value] of Object.entries(SPECS)) {
    it(`encodes and decodes ${name}`, () => {
      expect(deserialize(serialize(value))).toEqual(value);
    });
  }

  it("encodes -128 in the minimum width, int 8", () => {
    expect(toHex(serialize(-128))).toBe("d0-80");
  });
});
