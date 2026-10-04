/**
 * A burst of concurrent calls on a connection that does not exist yet.
 *
 * Every call that finds no connection to the peer dials it, and they all share
 * the one connection libp2p establishes. On the remote side, yamux counts the
 * streams that arrive before its own upgrade of that connection has finished
 * ("early streams") and, past `maxEarlyStreams` (10 by default), aborts the
 * WHOLE muxer: every stream on the connection dies, the remote sees EOF during
 * protocol negotiation and this side sees `StreamResetError`. On a fast local
 * link the window is a few milliseconds, so the burst only lost the race
 * sometimes (httpeers.core's "20 concurrent requests" test, ~1 run in 20).
 *
 * The server here delays its own upgrade (`denyInboundUpgradedConnection`
 * runs after the muxer exists and before the connection is handed over), so
 * the window is wide and the race is lost every time unless `connect()`
 * keeps the burst from arriving early.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { connect, serve } from "../src/connect-serve.js";

const UPGRADE_DELAY_MS = 200;
const BURST = 30;

let nodes: Libp2p[] = [];

afterEach(async () => {
  await Promise.allSettled(nodes.map((n) => n.stop()));
  nodes = [];
});

async function createNode(slowUpgrade: boolean): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    ...(slowUpgrade && {
      connectionGater: {
        denyInboundUpgradedConnection: async () => {
          await new Promise((resolve) => setTimeout(resolve, UPGRADE_DELAY_MS));
          return false;
        },
      },
    }),
  });
  nodes.push(node);
  return node;
}

async function* echo(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of input) yield chunk;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of source) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

describe("a burst of calls on a fresh connection", () => {
  it(`completes all ${BURST} concurrent calls while the remote is still upgrading`, async () => {
    const server = await createNode(true);
    const client = await createNode(false);
    await serve({ node: server, maxInboundStreams: 256 }, echo);
    const addr = server.getMultiaddrs()[0];
    if (!addr) throw new Error("server has no listen address");

    const { call } = await connect({ node: client, peer: addr, maxOutboundStreams: 256 });
    const results = await Promise.allSettled(
      Array.from({ length: BURST }, (_, i) =>
        collect(call([new TextEncoder().encode(`call ${i}`)])),
      ),
    );

    expectAllEchoed(results);
  }, 20_000);

  it(`completes ${BURST} calls made through ${BURST} separate connect()s to the same peer`, async () => {
    // Callers commonly connect() per request (httpeers.core does): the burst
    // still shares one libp2p connection, so the guard cannot live in a
    // single connect() instance.
    const server = await createNode(true);
    const client = await createNode(false);
    await serve({ node: server, maxInboundStreams: 256 }, echo);
    const addr = server.getMultiaddrs()[0];
    if (!addr) throw new Error("server has no listen address");

    const results = await Promise.allSettled(
      Array.from({ length: BURST }, async (_, i) => {
        const { call } = await connect({ node: client, peer: addr, maxOutboundStreams: 256 });
        return collect(call([new TextEncoder().encode(`call ${i}`)]));
      }),
    );

    expectAllEchoed(results);
  }, 20_000);

  it("needs nothing from the node but dialProtocol", async () => {
    // Callers pass narrow stand-ins (httpeers routes streams onto a kept relay
    // circuit with an object that has only `dialProtocol`).
    const server = await createNode(false);
    const client = await createNode(false);
    await serve({ node: server, maxInboundStreams: 256 }, echo);
    const addr = server.getMultiaddrs()[0];
    if (!addr) throw new Error("server has no listen address");
    const dialer = {
      dialProtocol: client.dialProtocol.bind(client),
    } as Pick<Libp2p, "dialProtocol"> as Libp2p;

    const { call } = await connect({ node: dialer, peer: addr, maxOutboundStreams: 256 });
    const results = await Promise.allSettled(
      Array.from({ length: BURST }, (_, i) =>
        collect(call([new TextEncoder().encode(`call ${i}`)])),
      ),
    );

    expectAllEchoed(results);
  }, 20_000);
});

function expectAllEchoed(results: PromiseSettledResult<string>[]): void {
  const failures = results.flatMap((r) =>
    r.status === "rejected"
      ? [`${(r.reason as Error)?.name}: ${(r.reason as Error)?.message}`]
      : [],
  );
  expect(failures).toEqual([]);
  expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(
    Array.from({ length: BURST }, (_, i) => `call ${i}`),
  );
}
