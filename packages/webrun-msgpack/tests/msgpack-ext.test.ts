import { describe, expect, it } from "vitest";
import { deserialize, MsgpackExtension, serialize } from "../src/index.js";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("extension values (#149)", () => {
  it("reads the ext type as a signed int8", () => {
    // fixext 1, type 0xfe (-2), one byte
    const value = deserialize(new Uint8Array([0xd4, 0xfe, 0x2a])) as MsgpackExtension;
    expect(value).toBeInstanceOf(MsgpackExtension);
    expect(value.type).toBe(-2);
    expect([...value.data]).toEqual([0x2a]);
    // ext 8, type 0x80 (-128)
    expect((deserialize(new Uint8Array([0xc7, 0x01, 0x80, 0x00])) as MsgpackExtension).type).toBe(
      -128,
    );
    // positive types are unchanged
    expect((deserialize(new Uint8Array([0xd4, 0x7f, 0x00])) as MsgpackExtension).type).toBe(127);
  });

  it("still reads type -1 as a timestamp", () => {
    expect(deserialize(new Uint8Array([0xd6, 0xff, 0, 0, 0, 1]))).toEqual(new Date(1000));
  });

  it("writes a MsgpackExtension as an ext, not a map", () => {
    const cases: [number, string][] = [
      [1, "d4"],
      [2, "d5"],
      [4, "d6"],
      [8, "d7"],
      [16, "d8"],
      [0, "c700"],
      [3, "c703"],
      [255, "c7ff"],
      [256, "c80100"],
      [0x10000, "c900010000"],
    ];
    for (const [size, prefix] of cases) {
      const data = new Uint8Array(size).fill(9);
      const bytes = serialize(new MsgpackExtension(-2, data));
      expect(hex(bytes).startsWith(`${prefix}fe`), `size ${size}`).toBe(true);
      expect(bytes.length).toBe(prefix.length / 2 + 1 + size);
    }
  });

  it("round-trips through serialize / deserialize", () => {
    for (const type of [-128, -2, 0, 5, 127]) {
      const ext = new MsgpackExtension(type, new Uint8Array([1, 2, 3]));
      const back = deserialize(serialize({ ext })) as { ext: MsgpackExtension };
      expect(back.ext).toBeInstanceOf(MsgpackExtension);
      expect(back.ext.type).toBe(type);
      expect([...back.ext.data]).toEqual([1, 2, 3]);
    }
  });

  it("leaves a plain { type, data } object a map", () => {
    const back = deserialize(serialize({ type: 1, data: new Uint8Array([1]) }));
    expect(back).not.toBeInstanceOf(MsgpackExtension);
    expect(back).toEqual({ type: 1, data: new Uint8Array([1]) });
  });

  it("refuses an ext type outside int8", () => {
    for (const type of [128, -129, 1.5, Number.NaN]) {
      expect(() => new MsgpackExtension(type, new Uint8Array())).toThrow(RangeError);
    }
  });
});
