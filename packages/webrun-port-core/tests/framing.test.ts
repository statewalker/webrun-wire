import { describe, expect, it } from "vitest";
import { encodeFrames, FLAG_CONT, FLAG_LAST, FrameReassembler } from "../src/index.js";

function flatten(frames: Uint8Array[]): Uint8Array {
  const len = frames.reduce((n, f) => n + f.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.byteLength;
  }
  return out;
}

function reassemble(frames: Uint8Array[]): Uint8Array {
  const r = new FrameReassembler();
  let last: Uint8Array | null = null;
  for (const f of frames) {
    const msg = r.push(f);
    if (msg !== null) {
      if (last !== null) {
        throw new Error("reassemble: more than one message in test input");
      }
      last = msg;
    }
  }
  if (last === null) throw new Error("reassemble: no message produced");
  return last;
}

describe("encodeFrames + FrameReassembler", () => {
  it("encodes small message as one LAST frame", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frames = encodeFrames(payload, 16);
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(FLAG_LAST);
    expect(Array.from(frames[0].subarray(1))).toEqual([1, 2, 3]);
  });

  it("encodes empty message as one LAST frame", () => {
    const frames = encodeFrames(new Uint8Array(0), 16);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(new Uint8Array([FLAG_LAST]));
  });

  it("encodes message exactly at MTU boundary as one LAST frame", () => {
    // mtu=4 → room=3 → payload of 3 bytes fits in one frame
    const payload = new Uint8Array([10, 20, 30]);
    const frames = encodeFrames(payload, 4);
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(FLAG_LAST);
  });

  it("encodes oversized message as CONT* LAST", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    // mtu=4 → room=3 → 8 bytes → ceil(8/3)=3 frames: CONT(1,2,3), CONT(4,5,6), LAST(7,8)
    const frames = encodeFrames(payload, 4);
    expect(frames).toHaveLength(3);
    expect(frames[0][0]).toBe(FLAG_CONT);
    expect(Array.from(frames[0].subarray(1))).toEqual([1, 2, 3]);
    expect(frames[1][0]).toBe(FLAG_CONT);
    expect(Array.from(frames[1].subarray(1))).toEqual([4, 5, 6]);
    expect(frames[2][0]).toBe(FLAG_LAST);
    expect(Array.from(frames[2].subarray(1))).toEqual([7, 8]);
  });

  it("round-trips small message", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const back = reassemble(encodeFrames(payload, 16));
    expect(Array.from(back)).toEqual([1, 2, 3]);
  });

  it("round-trips empty message", () => {
    const back = reassemble(encodeFrames(new Uint8Array(0), 16));
    expect(back.byteLength).toBe(0);
  });

  it("round-trips large message across many frames", () => {
    const size = 100_000;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) payload[i] = i & 0xff;
    const back = reassemble(encodeFrames(payload, 1024));
    expect(back.byteLength).toBe(size);
    for (let i = 0; i < size; i++) {
      if (back[i] !== (i & 0xff)) throw new Error(`mismatch at ${i}`);
    }
  });

  it("round-trips many consecutive messages with single-writer ordering", () => {
    const r = new FrameReassembler();
    const messages: number[][] = [];
    for (let m = 0; m < 50; m++) {
      const payload = new Uint8Array(20);
      payload.fill(m);
      messages.push(Array.from(payload));
      for (const frame of encodeFrames(payload, 8)) {
        const out = r.push(frame);
        if (out !== null) {
          const expected = messages.shift();
          expect(Array.from(out)).toEqual(expected);
        }
      }
    }
    expect(messages).toHaveLength(0);
  });

  it("rejects unknown frame flag", () => {
    const r = new FrameReassembler();
    expect(() => r.push(new Uint8Array([0x7f, 1, 2]))).toThrow();
  });

  it("rejects empty frame", () => {
    const r = new FrameReassembler();
    expect(() => r.push(new Uint8Array(0))).toThrow();
  });

  it("frame count and byte budget respect MTU for chunked message", () => {
    // payload=5, mtu=3, room=2 → frames: CONT(2), CONT(2), LAST(1) = 3 frames, 8 bytes total
    const frames = encodeFrames(new Uint8Array([9, 9, 9, 9, 9]), 3);
    expect(frames).toHaveLength(3);
    expect(frames[0].byteLength).toBeLessThanOrEqual(3);
    expect(frames[1].byteLength).toBeLessThanOrEqual(3);
    expect(frames[2].byteLength).toBeLessThanOrEqual(3);
    const total = flatten(frames).byteLength;
    expect(total).toBe(3 + 3 + 2); // two full + one short
  });
});
