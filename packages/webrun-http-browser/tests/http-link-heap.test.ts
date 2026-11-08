import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { connectHttpLink, serveHttpLink, trackedLink } from "../src/link/http-link.js";

// A body read over the link holds memory that does not grow with its number of
// chunks, and a link holds memory that does not grow with its number of
// requests: nothing the link keeps per chunk or per request outlives it.

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const MB = 1024 * 1024;
const CHUNKS = 200_000;
const FIRST = 20_000;
const LAST = 190_000;

function heapAfterGc(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe("a long body over the HTTP link", () => {
  it("keeps heap flat between chunks 20k and 190k", { timeout: 120_000 }, async () => {
    const channel = new MessageChannel();
    const stop = await serveHttpLink(channel.port2, () => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ === CHUNKS) controller.close();
            else controller.enqueue(new Uint8Array(16));
          },
        }),
      );
    });
    const link = await connectHttpLink(channel.port1);
    try {
      const response = await link.send(new Request("http://x/"));
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let bytes = 0;
      let atFirst = 0;
      let atLast = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        // Chunks may be coalesced on the way; count 16-byte units.
        const at = bytes / 16;
        if (!atFirst && at >= FIRST) atFirst = heapAfterGc();
        if (!atLast && at >= LAST) atLast = heapAfterGc();
      }
      expect(bytes).toBe(CHUNKS * 16);
      expect((atLast - atFirst) / MB).toBeLessThanOrEqual(4);
    } finally {
      await link.close();
      await stop();
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe("many requests on one link", () => {
  it("keep heap flat once their bodies end", { timeout: 60_000 }, async () => {
    const channel = new MessageChannel();
    const stop = await serveHttpLink(channel.port2, () => new Response("abc"));
    const link = await connectHttpLink(channel.port1);
    try {
      let atFirst = 0;
      for (let i = 0; i < 3_000; i++) {
        if (i === 300) atFirst = heapAfterGc();
        expect(await (await link.send(new Request("http://x/"))).text()).toBe("abc");
      }
      expect((heapAfterGc() - atFirst) / MB).toBeLessThanOrEqual(4);
    } finally {
      await link.close();
      await stop();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("keep heap flat when their signal is aborted as the head arrives", async () => {
    // One request, aborted once, sent again and again: a fresh aborted
    // `Request` per send would measure the runtime's own retention instead.
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://x/", { signal: controller.signal });
    const link = trackedLink(
      async () => new Response(new ReadableStream<Uint8Array>()),
      () => {},
    );
    let atFirst = 0;
    let aborted = 0;
    for (let i = 0; i < 5_000; i++) {
      if (i === 500) atFirst = heapAfterGc();
      await (await link.send(request)).text().catch((error: Error) => {
        if (error.name === "AbortError") aborted++;
      });
    }
    expect(aborted).toBe(5_000);
    expect(link.inflight).toBe(0);
    expect((heapAfterGc() - atFirst) / MB).toBeLessThanOrEqual(2);
  });
});
