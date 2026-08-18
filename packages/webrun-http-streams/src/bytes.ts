import type { ByteSource } from "./message.js";

const CR = 0x0d;
const LF = 0x0a;
const EMPTY = new Uint8Array(0);

export class ByteStreamError extends Error {
  override readonly name = "ByteStreamError";
}

export function toAsyncIterator(input: ByteSource): AsyncIterator<Uint8Array> {
  const asyncIter = (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator];
  if (asyncIter) return asyncIter.call(input as AsyncIterable<Uint8Array>);
  const syncIter = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    next(): Promise<IteratorResult<Uint8Array>> {
      return Promise.resolve(syncIter.next());
    },
  };
}

export function concatChunks(parts: Uint8Array[], totalLen: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Pull-based reader over a byte source. Holds at most one pending buffer, and
 * hands out `subarray` views rather than copies — a body never passes through
 * an allocation here.
 */
export class ByteReader {
  #iter: AsyncIterator<Uint8Array>;
  #buf: Uint8Array = EMPTY;
  #done = false;

  constructor(input: ByteSource) {
    this.#iter = toAsyncIterator(input);
  }

  /** Bytes already pulled from the source but not yet consumed. */
  bufferedLength(): number {
    return this.#buf.byteLength;
  }

  /** Pull one more non-empty chunk. Returns false at end of stream. */
  async #pull(): Promise<boolean> {
    if (this.#done) return false;
    while (true) {
      const next = await this.#iter.next();
      if (next.done) {
        this.#done = true;
        return false;
      }
      const chunk = next.value;
      if (chunk.byteLength === 0) continue;
      this.#buf =
        this.#buf.byteLength === 0
          ? chunk
          : concatChunks([this.#buf, chunk], this.#buf.byteLength + chunk.byteLength);
      return true;
    }
  }

  async peekByte(): Promise<number | undefined> {
    while (this.#buf.byteLength === 0) {
      if (!(await this.#pull())) return undefined;
    }
    return this.#buf[0];
  }

  /** Up to `max` bytes. `undefined` means end of stream. */
  async readSome(max: number): Promise<Uint8Array | undefined> {
    while (this.#buf.byteLength === 0) {
      if (!(await this.#pull())) return undefined;
    }
    const take = Math.min(max, this.#buf.byteLength);
    const out = this.#buf.subarray(0, take);
    this.#buf = this.#buf.subarray(take);
    return out;
  }

  /**
   * One CRLF-terminated line, without the CRLF. A bare LF is rejected: real
   * peers always send CRLF, and tolerating a bare LF is precisely the lenience
   * that lets request smuggling through a proxy pair.
   *
   * The `maxBytes` bound is best-effort: it only rejects a line if the check
   * happens to run before the line is fully buffered. A line already sitting in
   * the buffer bypasses the check. Callers needing a hard per-line limit or
   * aggregate bounds must keep their own running total.
   */
  async readLine(maxBytes: number): Promise<Uint8Array> {
    let searched = 0;
    while (true) {
      const idx = this.#buf.indexOf(LF, searched);
      if (idx !== -1) {
        if (idx === 0 || this.#buf[idx - 1] !== CR) {
          throw new ByteStreamError("bare LF line terminator; CRLF required");
        }
        const line = this.#buf.subarray(0, idx - 1);
        this.#buf = this.#buf.subarray(idx + 1);
        return line;
      }
      searched = this.#buf.byteLength;
      if (searched > maxBytes) {
        throw new ByteStreamError(`line exceeds ${maxBytes} bytes without CRLF`);
      }
      if (!(await this.#pull())) {
        throw new ByteStreamError(`stream ended after ${searched} bytes without CRLF`);
      }
    }
  }

  /** Everything not yet consumed, lazily. */
  async *rest(): AsyncGenerator<Uint8Array> {
    while (true) {
      if (this.#buf.byteLength > 0) {
        const out = this.#buf;
        this.#buf = EMPTY;
        yield out;
        continue;
      }
      if (!(await this.#pull())) return;
    }
  }
}
