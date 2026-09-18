/*!
 * MessagePack serializer and deserializer.
 *
 * A TypeScript port of msgpack.js by Yves Goergen:
 *   https://github.com/ygoe/msgpack.js
 *   ported from commit 05733cfb43a2974cf669f0eb8693f43b548bdcd4 (2024-04-16) on `master`,
 *   which carries three fixes that the last npm release, `@ygoe/msgpack@1.0.3`, does not.
 * Every change made to the upstream logic is listed in this package's README, section
 * "Provenance and credits".
 *
 * Original work: Copyright © 2019, Yves Goergen, https://unclassified.software/source/msgpack-js
 * TypeScript port and modifications: Copyright (c) 2026 statewalker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the “Software”), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** Options for {@link serialize}. */
export interface SerializeOptions {
  /**
   * Treat `data` as an array of values and concatenate their encodings, one MessagePack document
   * after another, instead of encoding the array itself. Default: `false`.
   */
  multiple?: boolean;
  /**
   * What to write in place of a value whose type cannot be serialized (a function, a symbol, a
   * bigint): either the replacement value itself, or a function that returns one given the
   * original. When absent, such a value throws.
   */
  invalidTypeReplacement?: unknown;
}

/** Options for {@link deserialize}. */
export interface DeserializeOptions {
  /**
   * Read every concatenated MessagePack document in the input and return them as an array.
   * Default: `false` — read one document and ignore any bytes after it.
   */
  multiple?: boolean;
}

/** The byte shapes {@link deserialize} accepts. */
export type MsgpackInput = Uint8Array | ArrayBuffer | ArrayLike<number>;

/** An extension value whose type this implementation does not interpret (anything but a timestamp). */
export interface MsgpackExtension {
  type: number;
  data: Uint8Array;
}

const pow32 = 0x100000000; // 2^32

/**
 * Serializes a value to a MessagePack byte array.
 *
 * The result is a view over a larger internal buffer; send the view, not its `.buffer`.
 */
export function serialize(data: unknown, options?: SerializeOptions): Uint8Array<ArrayBuffer> {
  if (options?.multiple && !Array.isArray(data)) {
    throw new Error("Invalid argument type: Expected an Array to serialize multiple values.");
  }
  let floatBuffer: ArrayBuffer | undefined;
  let floatView: DataView | undefined;
  let array = new Uint8Array(128);
  let length = 0;
  if (options?.multiple) {
    const values = data as unknown[];
    for (let i = 0; i < values.length; i++) {
      append(values[i]);
    }
  } else {
    append(data);
  }
  return array.subarray(0, length);

  function append(data: unknown, isReplacement?: boolean): void {
    switch (typeof data) {
      case "undefined":
        appendNull();
        break;
      case "boolean":
        appendBoolean(data);
        break;
      case "number":
        appendNumber(data);
        break;
      case "string":
        appendString(data);
        break;
      case "object":
        if (data === null) appendNull();
        else if (data instanceof Date) appendDate(data);
        else if (Array.isArray(data)) appendArray(data);
        else if (data instanceof Uint8Array || data instanceof Uint8ClampedArray)
          appendBinArray(data);
        else if (
          data instanceof Int8Array ||
          data instanceof Int16Array ||
          data instanceof Uint16Array ||
          data instanceof Int32Array ||
          data instanceof Uint32Array ||
          data instanceof Float32Array ||
          data instanceof Float64Array
        )
          appendArray(data);
        else appendObject(data as Record<string, unknown>);
        break;
      default: {
        const replacement = options?.invalidTypeReplacement;
        if (!isReplacement && options && replacement) {
          if (typeof replacement === "function") append(replacement(data), true);
          else append(replacement, true);
        } else {
          throw new Error(`Invalid argument type: The type '${typeof data}' cannot be serialized.`);
        }
      }
    }
  }

  function appendNull(): void {
    appendByte(0xc0);
  }

  function appendBoolean(data: boolean): void {
    appendByte(data ? 0xc3 : 0xc2);
  }

  function appendNumber(data: number): void {
    if (Number.isFinite(data) && Number.isSafeInteger(data)) {
      // Integer
      if (data >= 0 && data <= 0x7f) {
        appendByte(data);
      } else if (data < 0 && data >= -0x20) {
        appendByte(data);
      } else if (data > 0 && data <= 0xff) {
        // uint8
        appendBytes([0xcc, data]);
      } else if (data >= -0x80 && data <= 0x7f) {
        // int8
        appendBytes([0xd0, data]);
      } else if (data > 0 && data <= 0xffff) {
        // uint16
        appendBytes([0xcd, data >>> 8, data]);
      } else if (data >= -0x8000 && data <= 0x7fff) {
        // int16
        appendBytes([0xd1, data >>> 8, data]);
      } else if (data > 0 && data <= 0xffffffff) {
        // uint32
        appendBytes([0xce, data >>> 24, data >>> 16, data >>> 8, data]);
      } else if (data >= -0x80000000 && data <= 0x7fffffff) {
        // int32
        appendBytes([0xd2, data >>> 24, data >>> 16, data >>> 8, data]);
      } else if (data > 0 && data <= 2 ** 64) {
        // uint64 (upstream writes the bound as 0xffffffffffffffff, which is 2^64 as a double)
        appendByte(0xcf);
        appendInt64(data);
      } else if (data >= -(2 ** 63) && data <= 2 ** 63) {
        // int64 (upstream: -0x8000000000000000 and 0x7fffffffffffffff, i.e. -2^63 and 2^63)
        appendByte(0xd3);
        appendInt64(data);
      } else if (data < 0) {
        // below int64
        appendBytes([0xd3, 0x80, 0, 0, 0, 0, 0, 0, 0]);
      } else {
        // above uint64
        appendBytes([0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      }
    } else {
      // Float
      if (!floatView || !floatBuffer) {
        floatBuffer = new ArrayBuffer(8);
        floatView = new DataView(floatBuffer);
      }
      floatView.setFloat64(0, data);
      appendByte(0xcb);
      appendBytes(new Uint8Array(floatBuffer));
    }
  }

  function appendString(data: string): void {
    const bytes = encodeUtf8(data);
    const length = bytes.length;

    if (length <= 0x1f) appendByte(0xa0 + length);
    else if (length <= 0xff) appendBytes([0xd9, length]);
    else if (length <= 0xffff) appendBytes([0xda, length >>> 8, length]);
    else appendBytes([0xdb, length >>> 24, length >>> 16, length >>> 8, length]);

    appendBytes(bytes);
  }

  function appendArray(data: ArrayLike<unknown>): void {
    const length = data.length;

    if (length <= 0xf) appendByte(0x90 + length);
    else if (length <= 0xffff) appendBytes([0xdc, length >>> 8, length]);
    else appendBytes([0xdd, length >>> 24, length >>> 16, length >>> 8, length]);

    for (let index = 0; index < length; index++) {
      append(data[index]);
    }
  }

  function appendBinArray(data: Uint8Array | Uint8ClampedArray): void {
    const length = data.length;

    if (length <= 0xff) appendBytes([0xc4, length]);
    else if (length <= 0xffff) appendBytes([0xc5, length >>> 8, length]);
    else appendBytes([0xc6, length >>> 24, length >>> 16, length >>> 8, length]);

    appendBytes(data);
  }

  function appendObject(data: Record<string, unknown>): void {
    let length = 0;
    for (const key in data) {
      if (data[key] !== undefined) {
        length++;
      }
    }

    if (length <= 0xf) appendByte(0x80 + length);
    else if (length <= 0xffff) appendBytes([0xde, length >>> 8, length]);
    else appendBytes([0xdf, length >>> 24, length >>> 16, length >>> 8, length]);

    for (const key in data) {
      const value = data[key];
      if (value !== undefined) {
        append(key);
        append(value);
      }
    }
  }

  function appendDate(data: Date): void {
    const sec = data.getTime() / 1000;
    if (data.getMilliseconds() === 0 && sec >= 0 && sec < 0x100000000) {
      // 32 bit seconds
      appendBytes([0xd6, 0xff, sec >>> 24, sec >>> 16, sec >>> 8, sec]);
    } else if (sec >= 0 && sec < 0x400000000) {
      // 30 bit nanoseconds, 34 bit seconds
      const ns = data.getMilliseconds() * 1000000;
      appendBytes([
        0xd7,
        0xff,
        ns >>> 22,
        ns >>> 14,
        ns >>> 6,
        ((ns << 2) >>> 0) | (sec / pow32),
        sec >>> 24,
        sec >>> 16,
        sec >>> 8,
        sec,
      ]);
    } else {
      // 32 bit nanoseconds, 64 bit seconds, negative values allowed
      const ns = data.getMilliseconds() * 1000000;
      appendBytes([0xc7, 12, 0xff, ns >>> 24, ns >>> 16, ns >>> 8, ns]);
      appendInt64(sec);
    }
  }

  function appendByte(byte: number): void {
    if (array.length < length + 1) {
      let newLength = array.length * 2;
      while (newLength < length + 1) newLength *= 2;
      const newArray = new Uint8Array(newLength);
      newArray.set(array);
      array = newArray;
    }
    array[length] = byte;
    length++;
  }

  function appendBytes(bytes: ArrayLike<number>): void {
    if (array.length < length + bytes.length) {
      let newLength = array.length * 2;
      while (newLength < length + bytes.length) newLength *= 2;
      const newArray = new Uint8Array(newLength);
      newArray.set(array);
      array = newArray;
    }
    array.set(bytes, length);
    length += bytes.length;
  }

  function appendInt64(value: number): void {
    // Split 64 bit number into two 32 bit numbers because JavaScript only regards 32 bits for
    // bitwise operations.
    let hi: number;
    let lo: number;
    if (value >= 0) {
      // Same as uint64
      hi = value / pow32;
      lo = value % pow32;
    } else {
      // Split absolute value to high and low, then NOT and ADD(1) to restore negativity
      value++;
      hi = Math.abs(value) / pow32;
      lo = Math.abs(value) % pow32;
      hi = ~hi;
      lo = ~lo;
    }
    appendBytes([hi >>> 24, hi >>> 16, hi >>> 8, hi, lo >>> 24, lo >>> 16, lo >>> 8, lo]);
  }
}

/**
 * Deserializes a MessagePack byte array to a value.
 *
 * `bin` values are returned as `Uint8Array` views into the input, not copies.
 */
export function deserialize(input: MsgpackInput, options?: DeserializeOptions): unknown {
  let pos = 0;
  let array: Uint8Array;
  if (input instanceof Uint8Array) {
    array = input;
  } else if (input instanceof ArrayBuffer) {
    array = new Uint8Array(input);
  } else if (typeof input !== "object" || input === null || typeof input.length === "undefined") {
    throw new Error(
      "Invalid argument type: Expected a byte array (Array or Uint8Array) to deserialize.",
    );
  } else {
    array = new Uint8Array(input);
  }
  if (!array.length) {
    throw new Error("Invalid argument: The byte array to deserialize is empty.");
  }
  let data: unknown;
  if (options?.multiple) {
    // Read as many messages as are available
    const values: unknown[] = [];
    while (pos < array.length) {
      values.push(read());
    }
    data = values;
  } else {
    // Read only one message and ignore additional data
    data = read();
  }
  return data;

  function read(): unknown {
    const byte = array[pos++] as number;
    if (byte >= 0x00 && byte <= 0x7f) return byte; // positive fixint
    if (byte >= 0x80 && byte <= 0x8f) return readMap(byte - 0x80); // fixmap
    if (byte >= 0x90 && byte <= 0x9f) return readArray(byte - 0x90); // fixarray
    if (byte >= 0xa0 && byte <= 0xbf) return readStr(byte - 0xa0); // fixstr
    if (byte === 0xc0) return null; // nil
    if (byte === 0xc1) throw new Error("Invalid byte code 0xc1 found."); // never used
    if (byte === 0xc2) return false; // false
    if (byte === 0xc3) return true; // true
    if (byte === 0xc4) return readBin(-1, 1); // bin 8
    if (byte === 0xc5) return readBin(-1, 2); // bin 16
    if (byte === 0xc6) return readBin(-1, 4); // bin 32
    if (byte === 0xc7) return readExt(-1, 1); // ext 8
    if (byte === 0xc8) return readExt(-1, 2); // ext 16
    if (byte === 0xc9) return readExt(-1, 4); // ext 32
    if (byte === 0xca) return readFloat(4); // float 32
    if (byte === 0xcb) return readFloat(8); // float 64
    if (byte === 0xcc) return readUInt(1); // uint 8
    if (byte === 0xcd) return readUInt(2); // uint 16
    if (byte === 0xce) return readUInt(4); // uint 32
    if (byte === 0xcf) return readUInt(8); // uint 64
    if (byte === 0xd0) return readInt(1); // int 8
    if (byte === 0xd1) return readInt(2); // int 16
    if (byte === 0xd2) return readInt(4); // int 32
    if (byte === 0xd3) return readInt(8); // int 64
    if (byte === 0xd4) return readExt(1); // fixext 1
    if (byte === 0xd5) return readExt(2); // fixext 2
    if (byte === 0xd6) return readExt(4); // fixext 4
    if (byte === 0xd7) return readExt(8); // fixext 8
    if (byte === 0xd8) return readExt(16); // fixext 16
    if (byte === 0xd9) return readStr(-1, 1); // str 8
    if (byte === 0xda) return readStr(-1, 2); // str 16
    if (byte === 0xdb) return readStr(-1, 4); // str 32
    if (byte === 0xdc) return readArray(-1, 2); // array 16
    if (byte === 0xdd) return readArray(-1, 4); // array 32
    if (byte === 0xde) return readMap(-1, 2); // map 16
    if (byte === 0xdf) return readMap(-1, 4); // map 32
    if (byte >= 0xe0 && byte <= 0xff) return byte - 256; // negative fixint
    console.debug("msgpack array:", array);
    throw new Error(
      `Invalid byte value '${byte}' at index ${pos - 1} in the MessagePack binary data (length ${array.length}): Expecting a range of 0 to 255. This is not a byte array.`,
    );
  }

  function readInt(size: number): number {
    let value = 0;
    let first = true;
    while (size-- > 0) {
      if (first) {
        const byte = array[pos++] as number;
        value += byte & 0x7f;
        if (byte & 0x80) {
          value -= 0x80; // Treat most-significant bit as -2^i instead of 2^i
        }
        first = false;
      } else {
        value *= 256;
        value += array[pos++] as number;
      }
    }
    return value;
  }

  function readUInt(size: number): number {
    let value = 0;
    while (size-- > 0) {
      value *= 256;
      value += array[pos++] as number;
    }
    return value;
  }

  function readFloat(size: 4 | 8): number {
    const view = new DataView(array.buffer, pos + array.byteOffset, size);
    pos += size;
    return size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
  }

  function readBin(size: number, lengthSize?: number): Uint8Array {
    if (size < 0) size = readUInt(lengthSize as number);
    const data = array.subarray(pos, pos + size);
    pos += size;
    return data;
  }

  function readMap(size: number, lengthSize?: number): Record<string, unknown> {
    if (size < 0) size = readUInt(lengthSize as number);
    const data: Record<string, unknown> = {};
    while (size-- > 0) {
      const key = read();
      data[String(key)] = read();
    }
    return data;
  }

  function readArray(size: number, lengthSize?: number): unknown[] {
    if (size < 0) size = readUInt(lengthSize as number);
    const data: unknown[] = [];
    while (size-- > 0) {
      data.push(read());
    }
    return data;
  }

  function readStr(size: number, lengthSize?: number): string {
    if (size < 0) size = readUInt(lengthSize as number);
    const start = pos;
    pos += size;
    return decodeUtf8(array, start, size);
  }

  function readExt(size: number, lengthSize?: number): Date | MsgpackExtension {
    if (size < 0) size = readUInt(lengthSize as number);
    const type = readUInt(1);
    const data = readBin(size);
    switch (type) {
      case 255:
        return readExtDate(data);
    }
    return { type: type, data: data };
  }

  function readExtDate(data: Uint8Array): Date {
    const b = (i: number) => data[i] as number;
    if (data.length === 4) {
      const sec = ((b(0) << 24) >>> 0) + ((b(1) << 16) >>> 0) + ((b(2) << 8) >>> 0) + b(3);
      return new Date(sec * 1000);
    }
    if (data.length === 8) {
      const ns = ((b(0) << 22) >>> 0) + ((b(1) << 14) >>> 0) + ((b(2) << 6) >>> 0) + (b(3) >>> 2);
      const sec =
        (b(3) & 0x3) * pow32 +
        ((b(4) << 24) >>> 0) +
        ((b(5) << 16) >>> 0) +
        ((b(6) << 8) >>> 0) +
        b(7);
      return new Date(sec * 1000 + ns / 1000000);
    }
    if (data.length === 12) {
      const ns = ((b(0) << 24) >>> 0) + ((b(1) << 16) >>> 0) + ((b(2) << 8) >>> 0) + b(3);
      pos -= 8;
      const sec = readInt(8);
      return new Date(sec * 1000 + ns / 1000000);
    }
    throw new Error("Invalid data length for a date value.");
  }
}

/** Encodes a string to UTF-8 bytes. */
function encodeUtf8(str: string): Uint8Array {
  // Prevent excessive array allocation and slicing for all 7-bit characters
  let ascii = true;
  const length = str.length;
  for (let x = 0; x < length; x++) {
    if (str.charCodeAt(x) > 127) {
      ascii = false;
      break;
    }
  }

  // Based on: https://gist.github.com/pascaldekloe/62546103a1576803dade9269ccf76330
  let i = 0;
  const bytes = new Uint8Array(str.length * (ascii ? 1 : 4));
  for (let ci = 0; ci !== length; ci++) {
    let c = str.charCodeAt(ci);
    if (c < 128) {
      bytes[i++] = c;
      continue;
    }
    if (c < 2048) {
      bytes[i++] = (c >> 6) | 192;
    } else {
      if (c > 0xd7ff && c < 0xdc00) {
        if (++ci >= length) throw new Error("UTF-8 encode: incomplete surrogate pair");
        const c2 = str.charCodeAt(ci);
        if (c2 < 0xdc00 || c2 > 0xdfff)
          throw new Error(
            `UTF-8 encode: second surrogate character 0x${c2.toString(16)} at index ${ci} out of range`,
          );
        c = 0x10000 + ((c & 0x03ff) << 10) + (c2 & 0x03ff);
        bytes[i++] = (c >> 18) | 240;
        bytes[i++] = ((c >> 12) & 63) | 128;
      } else bytes[i++] = (c >> 12) | 224;
      bytes[i++] = ((c >> 6) & 63) | 128;
    }
    bytes[i++] = (c & 63) | 128;
  }
  return ascii ? bytes : bytes.subarray(0, i);
}

/** Decodes a string from UTF-8 bytes. */
function decodeUtf8(bytes: Uint8Array, start: number, length: number): string {
  // Based on: https://gist.github.com/pascaldekloe/62546103a1576803dade9269ccf76330
  const b = (index: number) => bytes[index] as number;
  let i = start;
  let str = "";
  length += start;
  while (i < length) {
    let c = b(i++);
    if (c > 127) {
      if (c > 191 && c < 224) {
        if (i >= length) throw new Error("UTF-8 decode: incomplete 2-byte sequence");
        c = ((c & 31) << 6) | (b(i++) & 63);
      } else if (c > 223 && c < 240) {
        if (i + 1 >= length) throw new Error("UTF-8 decode: incomplete 3-byte sequence");
        c = ((c & 15) << 12) | ((b(i++) & 63) << 6) | (b(i++) & 63);
      } else if (c > 239 && c < 248) {
        if (i + 2 >= length) throw new Error("UTF-8 decode: incomplete 4-byte sequence");
        c = ((c & 7) << 18) | ((b(i++) & 63) << 12) | ((b(i++) & 63) << 6) | (b(i++) & 63);
      } else
        throw new Error(
          `UTF-8 decode: unknown multibyte start 0x${c.toString(16)} at index ${i - 1}`,
        );
    }
    if (c <= 0xffff) str += String.fromCharCode(c);
    else if (c <= 0x10ffff) {
      c -= 0x10000;
      str += String.fromCharCode((c >> 10) | 0xd800);
      str += String.fromCharCode((c & 0x3ff) | 0xdc00);
    } else throw new Error(`UTF-8 decode: code point 0x${c.toString(16)} exceeds UTF-16 reach`);
  }
  return str;
}
