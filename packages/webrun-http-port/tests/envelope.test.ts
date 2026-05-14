import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../src/envelope.js";

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function* fromChunks(chunks: (Uint8Array | string)[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield typeof c === "string" ? enc.encode(c) : c;
}

describe("envelope framing", () => {
  it("round-trips envelope with no body", async () => {
    const env = { url: "/x", method: "GET", headers: [["accept", "*/*"]] };
    const wire = collectStream(encodeMessage(env));
    const { envelope, body } = await decodeMessage<typeof env>(await wire);
    expect(envelope).toEqual(env);
    const back = await collect(body);
    expect(back.byteLength).toBe(0);
  });

  it("round-trips envelope with body", async () => {
    const env = { url: "/x", method: "POST", headers: [] as [string, string][] };
    const bodyBytes = new Uint8Array([1, 2, 3, 4, 5]);
    async function* body() {
      yield bodyBytes;
    }
    const wireStream = encodeMessage(env, body());
    const { envelope, body: out } = await decodeMessage<typeof env>(wireStream);
    expect(envelope).toEqual(env);
    expect(Array.from(await collect(out))).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles envelope spanning multiple chunks", async () => {
    const env = { url: "/x", method: "GET", headers: [] as [string, string][] };
    const json = JSON.stringify(env);
    // Split the JSON in the middle across 3 chunks; \n at end of last.
    const chunks = [json.slice(0, 4), json.slice(4, 10), `${json.slice(10)}\n`];
    const { envelope, body } = await decodeMessage<typeof env>(fromChunks(chunks));
    expect(envelope).toEqual(env);
    expect((await collect(body)).byteLength).toBe(0);
  });

  it("handles envelope ending mid-chunk with body in same chunk", async () => {
    const env = { method: "POST" };
    const wire = `${JSON.stringify(env)}\nhello`;
    const { envelope, body } = await decodeMessage<typeof env>(fromChunks([wire]));
    expect(envelope).toEqual(env);
    expect(new TextDecoder().decode(await collect(body))).toBe("hello");
  });

  it("handles body spanning many chunks", async () => {
    const env = { url: "/x", method: "POST", headers: [] as [string, string][] };
    async function* body() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4, 5]);
      yield new Uint8Array([6]);
    }
    const wire = encodeMessage(env, body());
    const { body: out } = await decodeMessage<typeof env>(wire);
    expect(Array.from(await collect(out))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects malformed envelope JSON", async () => {
    await expect(decodeMessage(fromChunks(["{not-json\n"]))).rejects.toThrow(/malformed envelope/);
  });

  it("rejects stream ending before delimiter", async () => {
    await expect(decodeMessage(fromChunks(['{"method":"GET"']))).rejects.toThrow(
      /without delimiter/,
    );
  });

  it("skips zero-length input chunks", async () => {
    const env = { x: 1 };
    const { envelope } = await decodeMessage<typeof env>(
      fromChunks([new Uint8Array(0), `${JSON.stringify(env)}\n`]),
    );
    expect(envelope).toEqual(env);
  });

  it("encodes empty body as zero trailing chunks", async () => {
    const env = { x: 1 };
    const out: Uint8Array[] = [];
    for await (const c of encodeMessage(env)) out.push(c);
    expect(out).toHaveLength(1);
    const text = new TextDecoder().decode(out[0]);
    expect(text).toBe(`${JSON.stringify(env)}\n`);
  });
});

async function collectStream(s: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>> {
  const all: Uint8Array[] = [];
  for await (const c of s) all.push(c);
  async function* replay() {
    for (const c of all) yield c;
  }
  return replay();
}
