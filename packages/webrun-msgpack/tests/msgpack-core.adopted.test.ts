/**
 * Cases adopted from the test suites of two other JavaScript MessagePack implementations, rewritten
 * against `serialize`/`deserialize`:
 *
 * - msgpack-javascript, https://github.com/msgpack/msgpack-javascript/tree/6d4b666f061e49d5cccab88d266cf6cf1b96bbbf/test
 *   (ISC, © 2019 The MessagePack Community)
 * - msgpackr, https://github.com/kriszyp/msgpackr/tree/a9b9f1aa062461b333b48e66288da00e89ca8035/tests
 *   (MIT, © 2020 Kris Zyp)
 *
 * Each block names the file it comes from. Only cases about the MessagePack format itself are
 * taken; what those libraries add on top of it (records, bundled strings, BigInt, Map/Set,
 * extension registries, streaming decoders) has no counterpart here. Where this implementation's
 * contract deliberately differs from the source library's, the test pins this implementation's
 * behaviour and says so.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deserialize, serialize } from "../src/msgpack-core.js";

function roundTrip(data: unknown): unknown {
  return deserialize(serialize(data));
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("msgpack-javascript codec-int.test.ts: int64 / uint64", () => {
  const INT64SPECS: Record<string, number> = {
    ZERO: 0,
    ONE: 1,
    MINUS_ONE: -1,
    X_FF: 0xff,
    MINUS_X_FF: -0xff,
    INT32_MAX: 0x7fffffff,
    INT32_MIN: -0x7fffffff - 1,
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  };
  for (const [name, value] of Object.entries(INT64SPECS)) {
    it(`round-trips ${name} (${value})`, () => {
      expect(roundTrip(value)).toBe(value);
    });
  }

  // The source tests its int64 helpers directly; here the same values go through the int 64 and
  // uint 64 wire forms, both of which a decoder must read.
  it("reads MAX_SAFE_INTEGER and MIN_SAFE_INTEGER from int 64 and uint 64", () => {
    expect(deserialize(bytes(0xcf, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(deserialize(bytes(0xd3, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(deserialize(bytes(0xd3, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01))).toBe(
      Number.MIN_SAFE_INTEGER,
    );
  });
});

describe("msgpack-javascript codec-float.test.ts: float 32/64", () => {
  const SPECS: Record<string, number> = {
    POSITIVE_ZERO: +0.0,
    NEGATIVE_ZERO: -0.0,
    POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
    NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
    POSITIVE_VALUE_1: +0.1,
    POSITIVE_VALUE_2: +42,
    POSITIVE_VALUE_3: +Math.PI,
    POSITIVE_VALUE_4: +Math.E,
    NEGATIVE_VALUE_1: -0.1,
    NEGATIVE_VALUE_2: -42,
    NEGATIVE_VALUE_3: -Math.PI,
    NEGATIVE_VALUE_4: -Math.E,
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    MAX_VALUE: Number.MAX_VALUE,
    MIN_VALUE: Number.MIN_VALUE,
  };

  // The source builds the IEEE 754 bytes with the `ieee754` package; a DataView does the same.
  function float32(value: number): Uint8Array {
    const out = new Uint8Array(5);
    out[0] = 0xca;
    new DataView(out.buffer).setFloat32(1, value, false);
    return out;
  }
  function float64(value: number): Uint8Array {
    const out = new Uint8Array(9);
    out[0] = 0xcb;
    new DataView(out.buffer).setFloat64(1, value, false);
    return out;
  }

  for (const [name, value] of Object.entries(SPECS)) {
    it(`decodes float 32 ${name} (${value})`, () => {
      const expected = Math.fround(value);
      const decoded = deserialize(float32(value));
      expect(Object.is(decoded, expected), `matched sign: ${decoded}`).toBe(true);
    });
    it(`decodes float 64 ${name} (${value})`, () => {
      const decoded = deserialize(float64(value));
      expect(Object.is(decoded, value), `matched sign: ${decoded}`).toBe(true);
    });
  }

  it("decodes NaN from float 32 and float 64", () => {
    expect(deserialize(float32(Number.NaN))).toBeNaN();
    expect(deserialize(float64(Number.NaN))).toBeNaN();
  });

  it("writes a fractional number as float 64 (encode.test.ts, without forceFloat32)", () => {
    expect(serialize(3.14)).toEqual(bytes(0xcb, 0x40, 0x9, 0x1e, 0xb8, 0x51, 0xeb, 0x85, 0x1f));
  });

  it("writes an integer as an integer (encode.test.ts, without forceIntegerToFloat)", () => {
    expect(serialize(3)).toEqual(bytes(0x3));
  });
});

describe("msgpack-javascript codec-timestamp.test.ts: timestamp 32/64/96", () => {
  const TIME = 1556636810389;
  const SPECS: Record<string, Date> = {
    ZERO: new Date(0),
    TIME_BEFORE_EPOCH_NS: new Date(-1),
    TIME_BEFORE_EPOCH_SEC: new Date(-1000),
    TIME_BEFORE_EPOCH_SEC_AND_NS: new Date(-1002),
    TIMESTAMP32: new Date(Math.floor(TIME / 1000) * 1000),
    TIMESTAMP64: new Date(TIME),
    TIMESTAMP64_OVER_INT32: new Date(Date.UTC(2200, 0)),
    TIMESTAMP96_SEC_OVER_UINT32: new Date(0x400000000 * 1000),
    TIMESTAMP96_SEC_OVER_UINT32_WITH_NS: new Date(0x400000000 * 1000 + 2),
    REGRESSION_1: new Date(1556799054803),
  };
  for (const [name, value] of Object.entries(SPECS)) {
    it(`encodes and decodes ${name} (${value.toISOString()})`, () => {
      expect(roundTrip(value)).toEqual(value);
    });
  }

  it("writes a pre-1970 instant with its second floored, not truncated", () => {
    // -1002 ms is second -2 plus 998 ms. Upstream divided without flooring and wrote second -1,
    // which read back as -2 ms.
    const encoded = serialize(new Date(-1002));
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(encoded[0]).toBe(0xc7); // timestamp 96
    expect(view.getUint32(3, false)).toBe(998_000_000);
    expect(view.getBigInt64(7, false)).toBe(-2n);
  });

  it("refuses an invalid Date rather than writing some other instant", () => {
    // Upstream wrote an invalid Date as second -1, which reads back as 1969-12-31T23:59:59Z.
    expect(() => serialize(new Date(Number.NaN))).toThrow(/invalid Date/);
  });

  it("rejects a timestamp extension of an unrecognised size", () => {
    // fixext 1, type -1, one byte of payload
    expect(() => deserialize(bytes(0xd4, 0xff, 0x00))).toThrow(/Invalid data length for a date/);
  });
});

describe("msgpack-javascript edge-cases.test.ts", () => {
  it("throws on a cyclic array", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => serialize(cyclic)).toThrow();
  });

  it("throws on a cyclic object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.foo = cyclic;
    expect(() => serialize(cyclic)).toThrow();
  });

  it("throws on a value of an unsupported type", () => {
    expect(() => serialize(() => {})).toThrow(/cannot be serialized/);
    expect(() => serialize(Symbol("s"))).toThrow(/cannot be serialized/);
    expect(() => serialize(1n)).toThrow(/cannot be serialized/);
  });

  it("throws on the never-used type byte 0xc1", () => {
    expect(() => deserialize(bytes(0xc1))).toThrow(/0xc1/);
  });

  it("throws on an empty input", () => {
    expect(() => deserialize(new Uint8Array(0))).toThrow(/empty/);
  });

  it("refuses an empty input read as multiple documents too", () => {
    // The source's decodeMulti yields nothing for empty input; `deserialize` refuses empty input
    // before looking at `multiple`, and that is this implementation's contract.
    expect(() => deserialize(new Uint8Array(0), { multiple: true })).toThrow(/empty/);
  });

  it("ignores bytes after the first document (differs from the source, which throws)", () => {
    // msgpack-javascript's decode() rejects trailing bytes. `deserialize` reads one document and
    // ignores the rest, by upstream design; `{ multiple: true }` is the way to read them all.
    expect(deserialize(bytes(0x90, 0xc0))).toEqual([]);
    expect(deserialize(bytes(0x90, 0xc0), { multiple: true })).toEqual([[], null]);
  });
});

describe("msgpack-javascript decodeMulti.test.ts", () => {
  it("decodes multiple objects in a single binary", () => {
    const items = ["foo", 10, { name: "bar" }, [1, 2, 3]];
    const encoded = concat(items.map((item) => serialize(item)));
    expect(deserialize(encoded, { multiple: true })).toEqual(items);
    // and the encoder's own `multiple` produces the same bytes
    expect(serialize(items, { multiple: true })).toEqual(encoded);
  });
});

describe("msgpack-javascript encode.test.ts", () => {
  it("drops a key whose value is undefined (the source's ignoreUndefined: true)", () => {
    // msgpack-javascript writes such a key as nil by default; this implementation always drops it
    // — the behaviour webrun-rpc's spec D16 is written against.
    expect(roundTrip({ foo: undefined, bar: 42 })).toEqual({ bar: 42 });
  });

  it("writes undefined as nil where there is no key to drop", () => {
    expect(roundTrip(undefined)).toBe(null);
    expect(roundTrip([undefined, 1])).toEqual([null, 1]);
  });

  it("decodes from an ArrayBuffer as from a Uint8Array", () => {
    const buffer = serialize([1, 2, 3]);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteLength);
    expect(deserialize(arrayBuffer)).toEqual(deserialize(buffer));
  });

  it("decodes from a plain array of byte values", () => {
    expect(deserialize([0x93, 1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("msgpackr test.js: basic tests", () => {
  const samples = ["example", "example2", "example3", "example4", "example5"].map(
    (name) =>
      JSON.parse(
        readFileSync(new URL(`./fixtures/msgpackr/${name}.json`, import.meta.url), "utf8"),
      ) as unknown,
  );
  samples.push({ name: "some other types", date: new Date(), empty: "" });

  for (const sample of samples) {
    const snippet = `${JSON.stringify(sample).slice(0, 20)}...`;
    it(`pack/unpack sample data ${snippet}`, () => {
      expect(roundTrip(sample)).toEqual(sample);
    });
  }

  it("pack/unpack data", () => {
    const data = {
      data: [
        { a: 1, name: "one", type: "odd", isOdd: true },
        { a: 2, name: "two", type: "even" },
        { a: 3, name: "three", type: "odd", isOdd: true },
        { a: 4, name: "four", type: "even" },
        { a: 5, name: "five", type: "odd", isOdd: true },
        { a: 6, name: "six", type: "even", isOdd: null },
      ],
      description: "some names",
      types: ["odd", "even"],
      convertEnumToNum: [
        { prop: "test" },
        { prop: "test" },
        { prop: "test" },
        { prop: 1 },
        { prop: 2 },
        { prop: [undefined] },
        { prop: null },
      ],
    };
    // An array element has no key to drop, so `[undefined]` arrives as `[null]`; msgpackr's chai
    // deepEqual would not tell the two apart, vitest's does.
    const expected = structuredClone(data);
    expected.convertEnumToNum[5] = { prop: [null] as never };
    expect(roundTrip(data)).toEqual(expected);
  });

  it("mixed array", () => {
    const data = [
      "one",
      "two",
      "one",
      10,
      11,
      null,
      true,
      "three",
      "three",
      "one",
      [3, -5, -50, -400, 1.3, -5.3, true],
    ];
    expect(roundTrip(data)).toEqual(data);
  });

  it("255 chars", () => {
    const data =
      "RRZG9A6I7xupPeOZhxcOcioFsuhszGOdyDUcbRf4Zef2kdPIfC9RaLO4jTM5JhuZvTsF09fbRHMGtqk7YAgu3vespeTe9l61ziZ6VrMnYu2CamK96wCkmz0VUXyqaiUoTPgzk414LS9yYrd5uh7w18ksJF5SlC2e91rukWvNqAZJjYN3jpkqHNOFchCwFrhbxq2Lrv1kSJPYCx9blRg2hGmYqTbElLTZHv20iNqwZeQbRMgSBPT6vnbCBPnOh1W";
    expect(roundTrip(data)).toBe(data);
  });

  it("overlong UTF-8 string", () => {
    // msgpack fixstr of 2 bytes holding an overlong "/"; upstream decoded it to "/"
    expect(deserialize(bytes(0xa2, 0xc0, 0xaf))).not.toBe("/");
  });

  it("invalid UTF-8 continuation bytes", () => {
    const replacement = "\uFFFD";
    const strings: [number[], string][] = [
      [[0xc2, 0x41], `${replacement}A`],
      [[0xe1, 0x41, 0x42], `${replacement}AB`],
      [[0xe1, 0x80, 0x41], `${replacement}A`],
      [[0xf1, 0x41, 0x42, 0x43], `${replacement}ABC`],
      [[0xf1, 0x80, 0x41, 0x42], `${replacement}AB`],
      [[0xf1, 0x80, 0x80, 0x41], `${replacement}A`],
    ];
    for (const [data, expected] of strings) {
      expect(deserialize(bytes(0xa0 + data.length, ...data))).toBe(expected);
    }
  });

  it("truncated UTF-8 sequences do not consume following values", () => {
    expect(deserialize(bytes(0x92, 0xa1, 0xc2, 0x01))).toEqual(["\uFFFD", 1]);
    expect(deserialize(bytes(0x92, 0xa2, 0xe1, 0x80, 0x01))).toEqual(["\uFFFD", 1]);
    expect(deserialize(bytes(0x92, 0xa3, 0xf1, 0x80, 0x80, 0x01))).toEqual(["\uFFFD", 1]);
    expect(deserialize(bytes(0x93, 0xa1, 0xe0, 0xa4, 0x6e, 0x65, 0x78, 0x74, 0x07))).toEqual([
      "\uFFFD",
      "next",
      7,
    ]);
  });

  it("use ArrayBuffer", () => {
    const data = { prop: "a test" };
    const serialized = serialize(data);
    const ab = new ArrayBuffer(serialized.length);
    new Uint8Array(ab).set(serialized);
    expect(deserialize(ab)).toEqual(data);
  });

  it("object without prototype", () => {
    const data = Object.create(null) as Record<string, unknown>;
    data.test = 3;
    expect(roundTrip(data)).toEqual({ test: 3 });
  });

  it("random strings", () => {
    // msgpackr uses Math.random; a seeded generator keeps a failure reproducible.
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const data: string[] = [];
    for (let i = 0; i < 2000; i++) {
      let str = "test";
      while (random() < 0.7 && str.length < 0x100000) {
        str = str + String.fromCharCode(90 / (random() + 0.01)) + str;
      }
      data.push(str);
    }
    expect(roundTrip(data)).toEqual(data);
  });

  it("strings", () => {
    for (const data of [
      [""],
      "decode this: ᾜ",
      "decode this that is longer but without any non-latin characters",
    ]) {
      expect(roundTrip(data)).toEqual(data);
    }
  });

  it("fixint should be one byte", () => {
    expect(serialize(123).length).toBe(1);
  });

  it("numbers", () => {
    const data = {
      bigEncodable: 48978578104322,
      dateEpoch: 1530886513200,
      // msgpackr writes 3432235352353255323, which is this double
      realBig: 3432235352353255400,
      decimal: 32.55234,
      negative: -34.11,
      exponential: 0.234e123,
      tiny: 3.233e-120,
      zero: 0,
      Infinity: Number.POSITIVE_INFINITY,
    };
    expect(roundTrip(data)).toEqual(data);
  });

  it("negative zero arrives as zero (msgpackr leaves this case commented out)", () => {
    // -0 is a safe integer, so it is written as the fixint 0 and the sign is lost.
    expect(serialize(-0)).toEqual(bytes(0x00));
    expect(Object.is(roundTrip(-0), 0)).toBe(true);
  });

  it("buffers", () => {
    const data = {
      buffer1: new Uint8Array([2, 3, 4]),
      buffer2: new Uint8Array(serialize(samples[3])),
    };
    expect(roundTrip(data)).toEqual(data);
  });

  it("notepack test", () => {
    const data = {
      foo: 1,
      bar: [1, 2, 3, 4, "abc", "def"],
      foobar: {
        foo: true,
        bar: -2147483649,
        foobar: {
          foo: new Uint8Array([1, 2, 3, 4, 5]),
          bar: 1.5,
          foobar: [true, false, "abcdefghijkmonpqrstuvwxyz"],
        },
      },
    };
    expect(roundTrip(data)).toEqual(data);
  });

  it("utf16 causing expansion", () => {
    const data = {
      fixstr: "ᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝ",
      str8: "ᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝ".repeat(20),
    };
    expect(roundTrip(data)).toEqual(data);
  });

  it("unpackMultiple", () => {
    expect(deserialize(bytes(1, 2, 3, 4), { multiple: true })).toEqual([1, 2, 3, 4]);
  });
});

describe("msgpack-javascript edge-cases.test.ts: insufficient data", () => {
  it("throws a RangeError for an array missing an element", () => {
    expect(() =>
      deserialize(
        bytes(
          0x92, // fixarray size=2
          0xc0, // nil
        ),
      ),
    ).toThrow(RangeError);
  });
});

describe("msgpackr test-incomplete.js: encode and decode tests with partial values", () => {
  // msgpackr asserts an error flagged `incomplete`; the equivalent here is a RangeError for every
  // proper prefix of the encoding, where upstream msgpack.js returned NaN for a cut integer, a
  // short view for a cut bin, and threw assorted TypeErrors elsewhere.
  const tests: Record<string, unknown> = {
    string: "interesting string",
    number: 12345,
    float: 1.5,
    buffer: new TextEncoder().encode("hello world"),
    date: new Date(1556636810389),
    array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "many-strings": Array.from({ length: 100 }, (_, i) => `test-data-${i}`),
    object: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    "multibyte string": "ᾐᾑᾒ 🐀",
    "large int": 2 ** 40,
  };
  for (const [label, testData] of Object.entries(tests)) {
    it(label, () => {
      const encoded = serialize(testData);
      expect(deserialize(encoded)).toEqual(testData);
      for (let length = 1; length < encoded.length; length++) {
        // A fresh copy, so nothing past the cut is reachable through the underlying buffer.
        const prefix = encoded.slice(0, length);
        expect(() => deserialize(prefix), `prefix of ${length}/${encoded.length}`).toThrow(
          RangeError,
        );
      }
    });
  }

  it("does not read past the end of a view into a larger buffer", () => {
    // The view ends mid-float; the bytes after it in the buffer must not be read.
    const backing = Uint8Array.from([0xcb, 0x40, 0x09, 0x1e, 0xb8, 0x51, 0xeb, 0x85, 0x1f]);
    expect(() => deserialize(backing.subarray(0, 5))).toThrow(RangeError);
  });

  it("writes nothing to the console on malformed input", () => {
    // Upstream called console.debug with the whole input before throwing.
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      expect(() => deserialize(bytes(0x92, 0xc0))).toThrow();
      expect(debug).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });
});

describe("strings follow the WHATWG Encoding standard (TextEncoder / TextDecoder)", () => {
  // Not from another suite: the property the three msgpackr UTF-8 cases above are instances of.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  function strPayload(encoded: Uint8Array): Uint8Array {
    const head = encoded[0] as number;
    if (head >= 0xa0 && head <= 0xbf) return encoded.subarray(1);
    if (head === 0xd9) return encoded.subarray(2);
    if (head === 0xda) return encoded.subarray(3);
    return encoded.subarray(5);
  }

  let seed = 42;
  function random(): number {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  }

  it("writes a lone surrogate as U+FFFD instead of throwing or writing invalid UTF-8", () => {
    // Upstream threw on a lone high surrogate and wrote a lone low one as the invalid ED B0 80.
    expect(roundTrip("a\ud800")).toBe("a\ufffd");
    expect(roundTrip("\ud800b")).toBe("\ufffdb");
    expect(roundTrip("\udc00")).toBe("\ufffd");
    expect(roundTrip("\ud800\ud800\udc00")).toBe("\ufffd\u{10000}");
    expect(strPayload(serialize("\udc00"))).toEqual(bytes(0xef, 0xbf, 0xbd));
  });

  it("keeps a leading byte order mark", () => {
    expect(roundTrip("\ufeffabc")).toBe("\ufeffabc");
  });

  it("encodes any string to the bytes TextEncoder produces", () => {
    for (let n = 0; n < 2000; n++) {
      const units = Array.from({ length: Math.floor(random() * 40) }, () => {
        const pick = random();
        if (pick < 0.3) return Math.floor(random() * 0x80);
        if (pick < 0.5) return 0xd800 + Math.floor(random() * 0x800); // surrogates, paired or not
        return Math.floor(random() * 0x10000);
      });
      const str = String.fromCharCode(...units);
      expect(strPayload(serialize(str))).toEqual(encoder.encode(str));
      expect(roundTrip(str)).toBe(decoder.decode(encoder.encode(str)));
    }
  });

  it("decodes any bytes in a str the way TextDecoder does", () => {
    for (let n = 0; n < 2000; n++) {
      const payload = Uint8Array.from({ length: Math.floor(random() * 31) }, () => {
        const pick = random();
        if (pick < 0.3) return Math.floor(random() * 0x80);
        if (pick < 0.6) return 0x80 + Math.floor(random() * 0x40); // continuation bytes
        return Math.floor(random() * 0x100);
      });
      expect(deserialize(bytes(0xa0 + payload.length, ...payload))).toBe(decoder.decode(payload));
    }
  });
});

describe("msgpackr test-incomplete.js: unpack malformed containers", () => {
  // An array or map header declares its element count up front. Decoding must fail at once when
  // the elements are not there, and must not allocate for the declared count first.
  const malformedContainers: Record<string, number[]> = {
    "array32 declaring 20 million elements": [0xdd, 0x01, 0x31, 0x2d, 0x00],
    "array32 declaring 20 million elements with one present": [0xdd, 0x01, 0x31, 0x2d, 0x00, 0x01],
    "array32 declaring the maximum length": [0xdd, 0xff, 0xff, 0xff, 0xff],
    "array16 declaring 65535 elements": [0xdc, 0xff, 0xff],
    "nested array32 declaring a million elements each": [0xdd, 0, 0x10, 0, 0, 0xdd, 0, 0x10, 0, 0],
    "map32 declaring 20 million entries": [0xdf, 0x01, 0x31, 0x2d, 0x00],
    "map16 declaring 65535 entries": [0xde, 0xff, 0xff],
    "fixarray with no elements present": [0x9f],
  };
  for (const [label, data] of Object.entries(malformedContainers)) {
    it(label, { timeout: 1000 }, () => {
      expect(() => deserialize(Uint8Array.from(data))).toThrow();
    });
  }
});
