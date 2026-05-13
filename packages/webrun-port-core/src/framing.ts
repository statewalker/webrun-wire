export const FLAG_LAST = 0x00;
export const FLAG_CONT = 0x01;

export function encodeMessage(payload: Uint8Array, mtu: number): Uint8Array[] {
  if (mtu < 2) throw new RangeError(`mtu must be >= 2, got ${mtu}`);
  const room = mtu - 1;
  if (payload.byteLength <= room) {
    const out = new Uint8Array(payload.byteLength + 1);
    out[0] = FLAG_LAST;
    out.set(payload, 1);
    return [out];
  }
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset + room < payload.byteLength) {
    const frame = new Uint8Array(mtu);
    frame[0] = FLAG_CONT;
    frame.set(payload.subarray(offset, offset + room), 1);
    frames.push(frame);
    offset += room;
  }
  const tailLen = payload.byteLength - offset;
  const tail = new Uint8Array(tailLen + 1);
  tail[0] = FLAG_LAST;
  tail.set(payload.subarray(offset), 1);
  frames.push(tail);
  return frames;
}

export class FrameReassembler {
  private parts: Uint8Array[] = [];
  private totalLen = 0;

  push(frame: Uint8Array): Uint8Array | null {
    if (frame.byteLength < 1) {
      throw new Error("FrameReassembler: empty frame");
    }
    const flag = frame[0];
    const payload = frame.subarray(1);
    if (flag === FLAG_LAST) {
      if (this.parts.length === 0) {
        return payload.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(payload);
      }
      this.parts.push(payload);
      this.totalLen += payload.byteLength;
      const out = new Uint8Array(this.totalLen);
      let off = 0;
      for (const part of this.parts) {
        out.set(part, off);
        off += part.byteLength;
      }
      this.parts = [];
      this.totalLen = 0;
      return out;
    }
    if (flag === FLAG_CONT) {
      this.parts.push(new Uint8Array(payload));
      this.totalLen += payload.byteLength;
      return null;
    }
    throw new Error(`FrameReassembler: unknown flag 0x${flag.toString(16).padStart(2, "0")}`);
  }
}
