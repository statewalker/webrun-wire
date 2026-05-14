import { createWebSocketPort } from "@statewalker/webrun-port-ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { httpFetch, httpServe, type RequestEnvelope } from "../src/index.js";

/**
 * Cross-adapter integration smoke: HTTP over MessagePort over a real
 * WebSocket bridge. Demonstrates the full stack — adapter family +
 * webrun-http-port — works end-to-end without changing either layer.
 *
 * The same test should work for every adapter that satisfies
 * `webrun-port-conformance`. We use webrun-port-ws here because the test
 * infrastructure (in-process `ws` server) is hermetic and fast.
 */

interface PortPair {
  client: MessagePort;
  server: MessagePort;
  close(): Promise<void>;
}

async function makeWsPortPair(): Promise<PortPair> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const url = `ws://127.0.0.1:${address.port}`;

  const incoming = new Promise<NodeWebSocket>((resolve) => {
    wss.once("connection", (ws) => resolve(ws));
  });
  const clientWs = new NodeWebSocket(url);
  await new Promise<void>((resolve, reject) => {
    clientWs.once("open", () => resolve());
    clientWs.once("error", reject);
  });
  const serverWs = await incoming;
  clientWs.binaryType = "nodebuffer";
  serverWs.binaryType = "nodebuffer";

  const client = createWebSocketPort(clientWs as unknown as Parameters<typeof createWebSocketPort>[0]);
  const server = createWebSocketPort(serverWs as unknown as Parameters<typeof createWebSocketPort>[0]);

  return {
    client,
    server,
    async close() {
      try {
        client.close();
      } catch {}
      try {
        server.close();
      } catch {}
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

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

const emptyRequest: RequestEnvelope = { url: "/x", method: "GET", headers: [] };

describe("HTTP-over-port across a real WebSocket adapter", () => {
  let pair: PortPair;

  beforeEach(async () => {
    pair = await makeWsPortPair();
  });
  afterEach(async () => {
    await pair.close();
  });

  it("GET round-trip", async () => {
    const unsubscribe = httpServe(pair.server, async (env) => ({
      envelope: {
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/plain"]],
      },
      body: (async function* () {
        yield new TextEncoder().encode(`hello ${env.url}`);
      })(),
    }));
    try {
      const res = await httpFetch(pair.client, emptyRequest);
      expect(res.envelope.status).toBe(200);
      expect(new TextDecoder().decode(await collect(res.body))).toBe("hello /x");
    } finally {
      unsubscribe();
    }
  });

  it("POST with body", async () => {
    const unsubscribe = httpServe(pair.server, async (_env, body) => {
      const received = await collect(body);
      return {
        envelope: { status: 200, statusText: "OK", headers: [] },
        body: (async function* () {
          yield new Uint8Array([received.byteLength]);
        })(),
      };
    });
    try {
      const reqBody = (async function* () {
        yield new TextEncoder().encode("payload");
      })();
      const res = await httpFetch(
        pair.client,
        { url: "/upload", method: "POST", headers: [] },
        reqBody,
      );
      const out = await collect(res.body);
      expect(out[0]).toBe("payload".length);
    } finally {
      unsubscribe();
    }
  });

  it("streaming response across the bridge", async () => {
    const unsubscribe = httpServe(pair.server, async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: (async function* () {
        for (let i = 0; i < 20; i++) yield new Uint8Array([i]);
      })(),
    }));
    try {
      const res = await httpFetch(pair.client, emptyRequest);
      const got = await collect(res.body);
      expect(got.byteLength).toBe(20);
      for (let i = 0; i < 20; i++) expect(got[i]).toBe(i);
    } finally {
      unsubscribe();
    }
  });

  it("3 concurrent HTTP calls on one WS pair", async () => {
    const unsubscribe = httpServe(pair.server, async (env) => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: (async function* () {
        yield new TextEncoder().encode(env.url);
      })(),
    }));
    try {
      const results = await Promise.all(
        [0, 1, 2].map(async (i) => {
          const res = await httpFetch(pair.client, {
            url: `/concurrent/${i}`,
            method: "GET",
            headers: [],
          });
          return new TextDecoder().decode(await collect(res.body));
        }),
      );
      expect(results).toEqual(["/concurrent/0", "/concurrent/1", "/concurrent/2"]);
    } finally {
      unsubscribe();
    }
  });
});
