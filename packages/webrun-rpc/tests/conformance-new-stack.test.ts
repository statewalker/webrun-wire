import type { Duplex } from "@statewalker/webrun-streams";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import {
  duplexOverPort,
  multiplexPort,
  type PortMux,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";

/**
 * The B2 stack, end to end: one `MessageChannel`, `multiplexPort` on each end,
 * a virtual port per call, and `duplexOverPort` on that port.
 *
 * `PairTuning.maxMessageSize` is threaded into both muxes.
 * L6 (spec D17): this stack withholds a chunk's confirmation until the consumer has pulled past
 * it, so a producer is never more than a chunk ahead; the pair declares 8 KiB (two 4 KiB chunks).
 */
const makeNewStackPair: MakePair = async (tuning) => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();

  let serverMux: PortMux | undefined;
  let clientMux: PortMux | undefined;

  return {
    runAheadBytes: 8192,
    async connect() {
      clientMux ??= multiplexPort(channel.port1, {
        codec: structuredCodec,
        side: "initiator",
        maxMessageSize: tuning?.maxMessageSize,
      });
      const mux = clientMux;
      const call: Duplex = (input) =>
        (async function* () {
          const streamPort = await mux.openPort({ kind: "stream" });
          yield* duplexOverPort(streamPort, { maxMessageSize: mux.maxMessageSize })(input);
        })();
      return {
        call,
        async close() {
          /* the pair's own close tears the muxes down */
        },
      };
    },

    async serve(handler: Duplex) {
      const mux = multiplexPort(channel.port2, {
        codec: structuredCodec,
        side: "responder",
        maxMessageSize: tuning?.maxMessageSize,
        onPort: (port) => {
          serveDuplexOverPort(port, handler, { maxMessageSize: mux.maxMessageSize });
        },
      });
      serverMux = mux;
      let torn = false;
      return async () => {
        if (torn) return;
        torn = true;
        if (serverMux === mux) serverMux = undefined;
        await mux.close();
      };
    },

    async close() {
      await clientMux?.close().catch(() => {});
      await serverMux?.close().catch(() => {});
      clientMux = undefined;
      serverMux = undefined;
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

describeDuplexAdapter("webrun-rpc (multiplexPort + duplexOverPort)", makeNewStackPair);
