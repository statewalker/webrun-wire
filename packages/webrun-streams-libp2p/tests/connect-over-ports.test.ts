/**
 * `connect`/`serve` as a thin path over the windowed native port mux
 * (statewalker/webrun-wire#153): one call is one port, one port is one libp2p
 * stream negotiating `<protocol>/ports/window`, and `webrun-rpc`'s stream tier
 * runs the call with the port's credit window (default 4 MiB) as the only
 * flow control. The deprecated protocol stays served beside it for one
 * release (`interop-0-6.test.ts`).
 */
import type { Libp2p, Stream } from "@libp2p/interface";
import { measureRunAhead } from "@statewalker/webrun-streams-conformance";
import { afterEach, describe, expect, it } from "vitest";
import {
  connect,
  DEFAULT_PROTOCOL,
  DEFAULT_WINDOW,
  portProtocolOf,
  serve,
  serveConnections,
} from "../src/index.js";
import { windowProtocolOf } from "../src/port-mux.js";
import { makePortPairWith, nodePair, portRunAheadFor } from "./make-libp2p-pair.js";

const MiB = 1024 * 1024;
const te = new TextEncoder();
const td = new TextDecoder();

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pair() {
  const nodes = await nodePair();
  cleanups.push(nodes.close);
  return nodes;
}

/** Records the protocol every stream `node` dials settled on. */
function recordDials(node: Libp2p): { asked: string[][]; negotiated: string[] } {
  const seen = { asked: [] as string[][], negotiated: [] as string[] };
  const dial = node.dialProtocol.bind(node);
  node.dialProtocol = (async (peer, protocols, options) => {
    seen.asked.push([protocols].flat());
    const stream: Stream = await dial(peer, protocols, options);
    seen.negotiated.push(stream.protocol);
    return stream;
  }) as Libp2p["dialProtocol"];
  return seen;
}

async function echoOnce(call: (input: Iterable<Uint8Array>) => AsyncIterable<Uint8Array>) {
  const out: string[] = [];
  for await (const chunk of call([te.encode("ping")])) out.push(td.decode(chunk));
  return out.join("");
}

const echo = async function* (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  for await (const chunk of input) yield chunk;
};

describe("connect/serve over the windowed port mux: protocol ids", () => {
  it("the default window is 4 MiB", () => {
    expect(DEFAULT_WINDOW).toBe(4 * MiB);
  });

  it("the port protocol is the protocol with /ports appended", () => {
    expect(portProtocolOf(DEFAULT_PROTOCOL)).toBe("/webrun-streams/1.0.0/ports");
  });

  it("a new caller and a new server negotiate the windowed port protocol", async () => {
    const { server, client, addr } = await pair();
    const stop = await serve({ node: server }, echo);
    cleanups.push(stop);
    const dials = recordDials(client);
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(await echoOnce(call)).toBe("ping");
    const windowed = windowProtocolOf(portProtocolOf(DEFAULT_PROTOCOL));
    expect(dials.negotiated).toEqual([windowed, windowed]);
    // never the deprecated protocol between two new ends
    expect(dials.asked.flat()).not.toContain(DEFAULT_PROTOCOL);
  });

  it("a custom protocol id derives its port protocol the same way", async () => {
    const { server, client, addr } = await pair();
    const protocol = "/my-app/2.1.0";
    cleanups.push(await serve({ node: server, protocol }, echo));
    const dials = recordDials(client);
    const { call, close } = await connect({ node: client, peer: addr, protocol });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(dials.negotiated).toEqual(["/my-app/2.1.0/ports/window"]);
  });

  it("serve handles the port protocols and the deprecated one, and its teardown unhandles all", async () => {
    const { server } = await pair();
    const before = server.getProtocols();
    const stop = await serve({ node: server }, echo);
    const ports = portProtocolOf(DEFAULT_PROTOCOL);
    expect(server.getProtocols()).toEqual(
      expect.arrayContaining([DEFAULT_PROTOCOL, ports, windowProtocolOf(ports)]),
    );
    await stop();
    await stop(); // idempotent
    expect(server.getProtocols().sort()).toEqual([...before].sort());
  });

  it("refuses a window below 64 KiB on either end", async () => {
    const { server, client, addr } = await pair();
    await expect(connect({ node: client, peer: addr, window: 1024 })).rejects.toThrow(RangeError);
    await expect(serve({ node: server, window: 1024 }, echo)).rejects.toThrow(RangeError);
    // nothing left handled by the refused serve
    expect(server.getProtocols()).not.toContain(DEFAULT_PROTOCOL);
  });

  it("serveConnections tells each call's handler the peer Noise proved", async () => {
    const { server, client, addr } = await pair();
    const seen: string[] = [];
    cleanups.push(
      await serveConnections({ node: server }, ({ remotePeer }) => {
        seen.push(remotePeer.toString());
        return echo;
      }),
    );
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(await echoOnce(call)).toBe("ping");
    expect(seen).toEqual([client.peerId.toString(), client.peerId.toString()]);
  });
});

describe("connect/serve over the windowed port mux: the window bounds run-ahead (L6)", () => {
  for (const direction of ["response", "request"] as const) {
    it(`${direction}: the default 4 MiB window holds a producer to it, even over yamux's 16 MiB stream window`, async () => {
      const m = await measureRunAhead(() => makePortPairWith({ streamWindow: null }), direction);
      expect(m.ahead).toBeLessThanOrEqual(portRunAheadFor(DEFAULT_WINDOW));
      // the default is the window, not something smaller: a producer fills it
      expect(m.ahead).toBeGreaterThan(portRunAheadFor(1 * MiB));
      expect(m.complete).toBe(true);
      expect(m.intact).toBe(true);
    }, 60_000);

    it(`${direction}: a 1 MiB window option is honoured on both ends`, async () => {
      const m = await measureRunAhead(
        () => makePortPairWith({ window: 1 * MiB, streamWindow: null }),
        direction,
      );
      expect(m.ahead).toBeLessThanOrEqual(portRunAheadFor(1 * MiB));
      expect(m.complete).toBe(true);
      expect(m.intact).toBe(true);
    }, 60_000);
  }
});

describe("connect/serve over the windowed port mux: a handler that never reads its input", () => {
  it("answers a caller sending 8 MiB: the call completes, the unread input is dropped", async () => {
    const { server, client, addr } = await pair();
    cleanups.push(
      await serve({ node: server }, async function* () {
        yield te.encode("ok");
      }),
    );
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    const big = function* () {
      for (let i = 0; i < 128; i++) yield new Uint8Array(64 * 1024);
    };
    const out: Uint8Array[] = [];
    const started = Date.now();
    for await (const c of call(big())) out.push(c);
    expect(td.decode(out[0])).toBe("ok");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
