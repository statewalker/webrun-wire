import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_FRAME_BYTES,
  decodeFloat32Arrays,
  decodeMsgpack,
  encodeMsgpack,
} from "../src/index.js";

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of input) out.push(item);
  return out;
}

async function frameOf(value: unknown): Promise<Uint8Array> {
  const [frame] = await collect(encodeMsgpack([value]));
  return frame as Uint8Array;
}

function header(length: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

describe("decodeMsgpack reassembles a frame in linear time (#139)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("decodes a large frame split into many chunks, copying each byte a bounded number of times", async () => {
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const frame = await frameOf(payload);
    const step = 256;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i += step) chunks.push(frame.slice(i, i + step));
    expect(chunks.length).toBeGreaterThan(4000);

    // Count the bytes copied with `Uint8Array.prototype.set`. A rolling buffer that is
    // concatenated on every chunk copies ~ n²/2step bytes (about 2 GiB here); one allocation per
    // frame copies each byte once.
    let copied = 0;
    const original = Uint8Array.prototype.set;
    vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
      this: Uint8Array,
      source: ArrayLike<number>,
      offset?: number,
    ) {
      copied += source.length;
      return original.call(this, source, offset);
    });

    const [decoded] = await collect(decodeMsgpack<Uint8Array>(chunks));
    vi.restoreAllMocks();

    expect(decoded).toEqual(payload);
    expect(copied).toBeLessThanOrEqual(2 * frame.length);
  });

  it("decodes several frames across arbitrary chunk boundaries", async () => {
    const values = [{ a: 1 }, "two", [3, 4, 5], new Uint8Array(1000).fill(7), null];
    const frames = await collect(encodeMsgpack(values));
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
      all.set(f, o);
      o += f.length;
    }
    for (const step of [1, 3, 7, 64, 1001]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < all.length; i += step) chunks.push(all.subarray(i, i + step));
      expect(await collect(decodeMsgpack(chunks))).toEqual(values);
    }
  });
});

describe("decodeMsgpack bounds the peer's frame length (#139)", () => {
  it("defaults the ceiling to 64 MiB", () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(64 * 1024 * 1024);
  });

  it("throws a RangeError on a header past the default ceiling, before buffering the body", async () => {
    let pulled = 0;
    function* input() {
      yield header(0x7fffffff);
      for (let i = 0; i < 2000; i++) {
        pulled++;
        yield new Uint8Array(64 * 1024);
      }
    }
    await expect(collect(decodeMsgpack(input()))).rejects.toThrow(RangeError);
    expect(pulled).toBe(0);
  });

  it("honours maxFrameBytes", async () => {
    const frame = await frameOf("x".repeat(100));
    await expect(collect(decodeMsgpack([frame], { maxFrameBytes: 50 }))).rejects.toThrow(
      RangeError,
    );
    expect(await collect(decodeMsgpack([frame], { maxFrameBytes: 200 }))).toEqual([
      "x".repeat(100),
    ]);
  });

  it("applies maxFrameBytes to decodeFloat32Arrays", async () => {
    await expect(
      collect(decodeFloat32Arrays([header(1000)], { maxFrameBytes: 999 })),
    ).rejects.toThrow(RangeError);
  });

  it("rejects an invalid maxFrameBytes", () => {
    expect(() => decodeMsgpack([], { maxFrameBytes: -1 })).toThrow(RangeError);
    expect(() => decodeMsgpack([], { maxFrameBytes: Number.NaN })).toThrow(RangeError);
  });
});
