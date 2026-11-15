import type { Duplex } from "@statewalker/webrun-streams";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import {
  duplexOverPort,
  multiplexPort,
  type PortMux,
  type PortWindow,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";

/**
 * The B2 stack, end to end: one `MessageChannel`, `multiplexPort` on each end,
 * a virtual port per call, and `duplexOverPort` on that port.
 *
 * `PairTuning.maxMessageSize` is threaded into both muxes.
 * L6 (spec D17): this stack withholds a chunk's confirmation until the consumer has pulled past
 * it, so a producer is never more than a chunk ahead; the pair declares one 4 KiB chunk.
 */
const makeNewStackPair: MakePair = (tuning) => makeStackPair(tuning);

/**
 * The same stack with a `window` on both muxes. A windowed port pipelines its
 * chunks, so a stalled consumer has the producer up to the largest window the
 * receiver grants ahead, plus a chunk in each end's hands.
 */
function makeWindowedPair(window: PortWindow, largest: number): MakePair {
  return (tuning) => makeStackPair(tuning, { window, runAheadBytes: largest + 2 * 4096 });
}

const makeStackPair = async (
  tuning: Parameters<MakePair>[0],
  { window, runAheadBytes = 4096 }: { window?: PortWindow; runAheadBytes?: number } = {},
): ReturnType<MakePair> => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();

  let serverMux: PortMux | undefined;
  let clientMux: PortMux | undefined;

  return {
    runAheadBytes,
    async connect() {
      clientMux ??= multiplexPort(channel.port1, {
        codec: structuredCodec,
        side: "initiator",
        maxMessageSize: tuning?.maxMessageSize,
        window,
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
        window,
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

// #188: the same suite over an adaptive window, and over the fixed one it
// starts from.
describeDuplexAdapter(
  "webrun-rpc (multiplexPort + duplexOverPort, window 16 KiB)",
  makeWindowedPair(16 * 1024, 16 * 1024),
);
describeDuplexAdapter(
  "webrun-rpc (multiplexPort + duplexOverPort, adaptive window 16-128 KiB)",
  makeWindowedPair({ initial: 16 * 1024, max: 128 * 1024 }, 128 * 1024),
);
