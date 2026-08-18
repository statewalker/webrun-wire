import { describe, expect, it } from "vitest";
import { httpCodec } from "../src/http1/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("note 15's proof questions, re-run against HTTP/1.1 framing", () => {
  it("Q1: a query string survives encode and decode intact", async () => {
    const url = "http://h.test/p?a=1&b=two&empty=&enc=%7B%7D&plus=a+b";
    const decoded = await httpCodec.decodeRequest(
      httpCodec.encodeRequest({ url, method: "GET", headers: [] }),
    );
    expect(decoded.envelope.url).toBe(url);
  });

  it("Q2: a request body streams — the first chunk arrives before the last is sent", async () => {
    const sent: number[] = [];
    async function* slow() {
      for (let i = 0; i < 4; i++) {
        await sleep(25);
        sent.push(Date.now());
        yield enc(`chunk${i}`);
      }
    }

    const decoded = await httpCodec.decodeRequest(
      httpCodec.encodeRequest({ url: "http://h.test/x", method: "POST", headers: [] }, slow()),
    );

    const arrived: number[] = [];
    let seen = "";
    let sentWhenFirstArrived = -1;
    const dec = new TextDecoder();
    for await (const chunk of decoded.body) {
      arrived.push(Date.now());
      if (sentWhenFirstArrived === -1) sentWhenFirstArrived = sent.length;
      seen += dec.decode(chunk, { stream: true });
    }
    seen += dec.decode();

    expect(seen).toBe("chunk0chunk1chunk2chunk3");
    // Streaming means the first chunk is handed over while the producer is still
    // on its first chunk — not after it has run ahead. This catches partial
    // buffering, which the arrival-vs-send comparison below cannot see.
    expect(sentWhenFirstArrived).toBe(1);
    // The assertion that mirrors the original proof: it fails if the codec ever
    // silently buffers the whole body before handing any of it over.
    expect(arrived[0]).toBeLessThan(sent[sent.length - 1]);
  });

  it("Q3: a response body streams the same way", async () => {
    const sent: number[] = [];
    async function* slow() {
      for (let i = 0; i < 4; i++) {
        await sleep(25);
        sent.push(Date.now());
        yield enc(`part${i}`);
      }
    }

    const decoded = await httpCodec.decodeResponse(
      httpCodec.encodeResponse({ status: 200, statusText: "OK", headers: [] }, slow()),
      { method: "GET" },
    );

    const arrived: number[] = [];
    let sentWhenFirstArrived = -1;
    for await (const _chunk of decoded.body) {
      arrived.push(Date.now());
      if (sentWhenFirstArrived === -1) sentWhenFirstArrived = sent.length;
    }

    expect(arrived).toHaveLength(4);
    // Streaming means the first chunk is handed over while the producer is still
    // on its first chunk — not after it has run ahead. This catches partial
    // buffering, which the arrival-vs-send comparison below cannot see.
    expect(sentWhenFirstArrived).toBe(1);
    // The assertion that mirrors the original proof.
    expect(arrived[0]).toBeLessThan(sent[sent.length - 1]);
  });

  it("Q5: a 4 MB body transits in pieces, never as one buffer", async () => {
    const PIECE = new Uint8Array(64 * 1024).fill(0x61);
    const COUNT = 64; // 4 MiB
    let sourceYielded = 0;
    async function* big() {
      for (let i = 0; i < COUNT; i++) {
        sourceYielded++;
        yield PIECE;
      }
    }

    const decoded = await httpCodec.decodeRequest(
      httpCodec.encodeRequest({ url: "http://h.test/big", method: "POST", headers: [] }, big()),
    );

    let total = 0;
    let largest = 0;
    let pieces = 0;
    let sourceWhenFirstArrived = -1;
    for await (const chunk of decoded.body) {
      total += chunk.byteLength;
      largest = Math.max(largest, chunk.byteLength);
      if (sourceWhenFirstArrived === -1) sourceWhenFirstArrived = sourceYielded;
      pieces += 1;
    }

    expect(total).toBe(COUNT * PIECE.byteLength);
    expect(pieces).toBeGreaterThan(1);
    // The consumer sees data before the producer has run ahead: materiali​zation is
    // bounded by the pull-driven consumption.
    expect(sourceWhenFirstArrived).toBeLessThanOrEqual(2);
    // No step ever held more than one source piece at a time.
    expect(largest).toBeLessThanOrEqual(PIECE.byteLength);
  });
});
