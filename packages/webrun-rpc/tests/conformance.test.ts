import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

/**
 * `PairTuning` is a credit window — `mtu` plus `maxStreamBuffer` — and
 * `connect`/`serve` no longer have one to size: a chunk's reply is withheld
 * until the consumer has pulled past it, so the window is one chunk and is not
 * configurable. Only half of the tuning survives the translation:
 *
 *  - `mtu` maps to `maxMessageSize`. Both are "how large may one message on the
 *    wire be", so L6 still runs at a 4 KiB frame against a 256 KiB body and
 *    still makes the sender take 64 turns rather than one.
 *  - `maxStreamBuffer` is dropped. There is no buffer to cap. Passing it on as
 *    anything would be a lie about what this stack does.
 *
 * So for this pair L6 proves chunking and integrity under a small frame, and it
 * proves that the per-chunk handshake survives a deliberately slow drain. It
 * does **not** prove credit replenishment, because there is no credit. The
 * bounded-memory property this stack has instead is measured directly in
 * `connect-serve-backpressure.test.ts`; do not cite this level for it.
 */
const makePortPair: MakePair = async (tuning) => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const shared = { codec: structuredCodec, maxMessageSize: tuning?.mtu };
  return {
    connect: () => connect({ mux: overPipe(channel.port1, { ...shared, side: "initiator" }) }),
    serve: (handler) =>
      serve({ mux: overPipe(channel.port2, { ...shared, side: "responder" }) }, handler),
    close: async () => {
      try {
        channel.port1.close();
      } catch {
        /* ignore */
      }
      try {
        channel.port2.close();
      } catch {
        /* ignore */
      }
    },
  };
};

describeDuplexAdapter("webrun-rpc (MessageChannel pair)", makePortPair);
