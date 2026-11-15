/**
 * Old and new peers interoperate for the release that keeps the deprecated
 * protocol (statewalker/webrun-wire#153), in both directions, against the
 * published 0.6.0 (the last release whose `connect`/`serve` ran their own
 * flow control on `/webrun-streams/1.0.0`):
 *
 * - an old caller reaches a new server, which still serves the old protocol;
 * - a new caller reaches an old server: the port protocol is refused, so it
 *   falls back to the old protocol, and remembers that for the connection.
 */
import type { Libp2p, Stream } from "@libp2p/interface";
import { describeDuplexAdapter, type MakePair } from "@statewalker/webrun-streams-conformance";
import { afterEach, describe, expect, it } from "vitest";
import {
  connect as oldConnect,
  serve as oldServe,
  serveConnections as oldServeConnections,
} from "webrun-streams-libp2p-0-6";
import {
  connect,
  DEFAULT_PROTOCOL,
  portProtocolOf,
  serve,
  serveConnections,
} from "../src/index.js";
import { nodePair, PAIR_STREAM_WINDOW, runAheadFor } from "./make-libp2p-pair.js";

const te = new TextEncoder();
const td = new TextDecoder();

/** Old caller, new server: the server's deprecated handler answers. */
const oldToNew: MakePair = async () => {
  const nodes = await nodePair();
  return {
    runAheadBytes: runAheadFor(PAIR_STREAM_WINDOW),
    connect: () => oldConnect({ node: nodes.client, peer: nodes.addr }),
    serve: (handler) => serve({ node: nodes.server }, handler),
    close: nodes.close,
  };
};

/** New caller, old server: the caller falls back to the deprecated protocol. */
const newToOld: MakePair = async () => {
  const nodes = await nodePair();
  return {
    runAheadBytes: runAheadFor(PAIR_STREAM_WINDOW),
    connect: () => connect({ node: nodes.client, peer: nodes.addr }),
    serve: (handler) => oldServe({ node: nodes.server }, handler),
    close: nodes.close,
  };
};

describeDuplexAdapter("interop: 0.6.0 connect -> new serve", oldToNew, { skipHugeBody: true });
describeDuplexAdapter("interop: new connect -> 0.6.0 serve", newToOld, { skipHugeBody: true });

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pair() {
  const nodes = await nodePair();
  cleanups.push(nodes.close);
  return nodes;
}

function recordDials(node: Libp2p): { asked: string[][]; negotiated: string[]; failed: number } {
  const seen = { asked: [] as string[][], negotiated: [] as string[], failed: 0 };
  const dial = node.dialProtocol.bind(node);
  node.dialProtocol = (async (peer, protocols, options) => {
    seen.asked.push([protocols].flat());
    try {
      const stream: Stream = await dial(peer, protocols, options);
      seen.negotiated.push(stream.protocol);
      return stream;
    } catch (err) {
      seen.failed++;
      throw err;
    }
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

describe("interop with 0.6.0: new caller -> old server", () => {
  it("falls back to the deprecated protocol once, then dials it directly", async () => {
    const { server, client, addr } = await pair();
    cleanups.push(await oldServe({ node: server }, echo));
    const dials = recordDials(client);
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(dials.failed).toBe(1);
    expect(dials.negotiated).toEqual([DEFAULT_PROTOCOL]);
    // remembered for the connection, by every connect() from this node to that peer
    const again = await connect({ node: client, peer: addr });
    cleanups.push(again.close);
    expect(await echoOnce(again.call)).toBe("ping");
    expect(await echoOnce(call)).toBe("ping");
    expect(dials.failed).toBe(1);
    expect(dials.negotiated).toEqual([DEFAULT_PROTOCOL, DEFAULT_PROTOCOL, DEFAULT_PROTOCOL]);
  });

  it("probes again once the connection to the old server is gone", async () => {
    const { server, client, addr } = await pair();
    cleanups.push(await oldServe({ node: server }, echo));
    const dials = recordDials(client);
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    for (const connection of client.getConnections()) await connection.close();
    expect(await echoOnce(call)).toBe("ping");
    expect(dials.failed).toBe(2);
  });

  it("a burst of first calls all fall back", async () => {
    const { server, client, addr } = await pair();
    cleanups.push(await oldServe({ node: server }, echo));
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    const results = await Promise.all(Array.from({ length: 20 }, () => echoOnce(call)));
    expect(results).toEqual(Array.from({ length: 20 }, () => "ping"));
  });

  it("a custom protocol id falls back to that protocol", async () => {
    const { server, client, addr } = await pair();
    const protocol = "/my-app/2.1.0";
    cleanups.push(await oldServe({ node: server, protocol }, echo));
    const dials = recordDials(client);
    const { call, close } = await connect({ node: client, peer: addr, protocol });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(dials.asked[0]).toContain(`${portProtocolOf(protocol)}/window`);
    expect(dials.negotiated).toEqual([protocol]);
  });

  it("an old serveConnections still learns the caller's peer id", async () => {
    const { server, client, addr } = await pair();
    const seen: string[] = [];
    cleanups.push(
      await oldServeConnections({ node: server }, ({ remotePeer }) => {
        seen.push(remotePeer.toString());
        return echo;
      }),
    );
    const { call, close } = await connect({ node: client, peer: addr });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(seen).toEqual([client.peerId.toString()]);
  });
});

describe("interop with 0.6.0: old caller -> new server", () => {
  it("is answered on the deprecated protocol, with the caller's peer id", async () => {
    const { server, client, addr } = await pair();
    const seen: string[] = [];
    cleanups.push(
      await serveConnections({ node: server }, ({ remotePeer }) => {
        seen.push(remotePeer.toString());
        return echo;
      }),
    );
    const dials = recordDials(client);
    const { call, close } = await oldConnect({ node: client, peer: addr });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
    expect(dials.negotiated).toEqual([DEFAULT_PROTOCOL]);
    expect(seen).toEqual([client.peerId.toString()]);
  });

  it("a custom protocol id is served for old callers too", async () => {
    const { server, client, addr } = await pair();
    const protocol = "/my-app/2.1.0";
    cleanups.push(await serve({ node: server, protocol }, echo));
    const { call, close } = await oldConnect({ node: client, peer: addr, protocol });
    cleanups.push(close);
    expect(await echoOnce(call)).toBe("ping");
  });

  it("old and new callers are served side by side", async () => {
    const { server, client, addr } = await pair();
    cleanups.push(await serve({ node: server }, echo));
    const oldEnd = await oldConnect({ node: client, peer: addr });
    const newEnd = await connect({ node: client, peer: addr });
    cleanups.push(oldEnd.close, newEnd.close);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => echoOnce(i % 2 ? oldEnd.call : newEnd.call)),
    );
    expect(results).toEqual(Array.from({ length: 10 }, () => "ping"));
  });
});
