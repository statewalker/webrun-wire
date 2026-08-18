import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { describe, expect, it, vi } from "vitest";
import { connect, serveConnections } from "../src/index.js";

async function node(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const echo = async function* echo(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of input) yield chunk;
};

async function drain(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

/**
 * Regression test for the crash described in the branch's final review: the
 * per-stream body in `serveConnections` ran as a bare `void (async () => …)()`
 * with a `try/finally` and no `catch`. `duplexOverStream` rejects on the read
 * side when the peer sends an ERROR frame (`duplex-over-stream.ts`), so a
 * single failing request produced an unhandled rejection — which terminates
 * the process under Node's default `unhandledRejection` behaviour, killing the
 * relay for every other peer.
 *
 * Verified to fail before the fix: removing the `.catch(...)` from
 * `serveConnections` makes this fail with
 * `expected [ Error: hostile peer input ] to deeply equal []` and vitest
 * additionally reports the same rejection as an unhandled error.
 */
describe("serveConnections resilience", () => {
  it("survives a peer whose request errors, and keeps serving other peers", async () => {
    const server = await node(true);
    const hostile = await node(false);
    const friendly = await node(false);

    // Node terminates on unhandled rejections only when nothing listens, so
    // observe them directly rather than trying to survive a process exit.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    // The fix logs the failure; keep the expected noise out of the report and
    // assert it was actually reported.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const stop = await serveConnections({ node: server }, () => echo);
      const addr = server.getMultiaddrs()[0];
      if (addr == null) throw new Error("server has no listen address");

      const hostileConn = await connect({ node: hostile, peer: addr });
      try {
        // The peer's own source throws mid-stream. `framedOutbound` turns that
        // into an ERROR frame on the wire, which the handler side rethrows.
        await drain(
          hostileConn.call(
            (async function* () {
              yield encoder.encode("hello");
              throw new Error("hostile peer input");
            })(),
          ),
        );
      } catch {
        // What the hostile caller itself sees is not under test — only that
        // the server outlives it.
      }
      await hostileConn.close();

      // Give the rejection a chance to be reported before asserting on it.
      await new Promise((r) => setTimeout(r, 250));

      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalled();

      // The server is still serving: a different peer's call still round-trips.
      const friendlyConn = await connect({ node: friendly, peer: addr });
      const out = await drain(
        friendlyConn.call(
          (async function* () {
            yield encoder.encode("still alive");
          })(),
        ),
      );
      await friendlyConn.close();
      expect(out.map((c) => decoder.decode(c)).join("")).toBe("still alive");

      await stop();
    } finally {
      warn.mockRestore();
      process.off("unhandledRejection", onUnhandled);
      await Promise.allSettled([server.stop(), hostile.stop(), friendly.stop()]);
    }
  });
});
