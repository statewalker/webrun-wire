import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

/**
 * The port stack over one `MessageChannel`. `PairTuning.maxMessageSize` becomes
 * the mux's `maxMessageSize`, so L6's body crosses as 4 KiB chunks.
 * L6 (spec D17): this stack withholds a chunk's confirmation until the consumer has pulled past
 * it, so a producer is never more than a chunk ahead; the pair declares 8 KiB (two 4 KiB chunks).
 */
const makePortPair: MakePair = async (tuning) => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const shared = { codec: structuredCodec, maxMessageSize: tuning?.maxMessageSize };
  return {
    runAheadBytes: 8192,
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
