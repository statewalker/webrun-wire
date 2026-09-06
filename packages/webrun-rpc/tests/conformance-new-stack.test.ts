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
 * `PairTuning` is deliberately ignored. L6 asks for a credit window
 * (`mtu`, `maxStreamBuffer`) that this design removes — under spec D11 there
 * is no window to shrink — so for this pair **L6 is an integrity check only**:
 * its green says the body round-trips, and says nothing at all about flow
 * control. That is not an oversight. L6's redefinition and the `PairTuning`
 * reshape are spec D17, sequenced into Plan C because five adapters still run
 * L6 against `emulateMux`, where the credit window is real and the level does
 * cover it.
 *
 * This stack's flow-control coverage lives in its own files:
 * `duplex-over-port-timeout.test.ts` (the F5 regression, and that progress
 * resets the clock) and `duplex-over-port-hostile.test.ts` (a second
 * unconfirmed chunk is refused). Do not cite this L6 as evidence for either.
 */
const makeNewStackPair: MakePair = async () => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();

  let serverMux: PortMux | undefined;
  let clientMux: PortMux | undefined;

  return {
    async connect() {
      clientMux ??= multiplexPort(channel.port1, {
        codec: structuredCodec,
        side: "initiator",
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
