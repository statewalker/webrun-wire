import type { MessageListener, MessageTarget, PortMux } from "@statewalker/webrun-rpc";
import { duplexOverPort, multiplexPort, serveDuplexOverPort } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { msgpackCodec } from "../src/index.js";

/**
 * Two `MessageTarget`s that exchange **bytes**, delivered on a later
 * macrotask and in order — the same contract a WebSocket, a data channel or a
 * LiveKit packet stream offers, with none of the transport.
 *
 * This is deliberately not a `MessageChannel`: a `MessageChannel` carries
 * structured values, which is the case `structuredCodec` already covers. What
 * is unproven is the byte path.
 */
function bytePipePair(): { a: MessageTarget; b: MessageTarget; close(): void } {
  const listeners: [Set<MessageListener>, Set<MessageListener>] = [new Set(), new Set()];
  let open = true;

  const make = (self: 0 | 1): MessageTarget => {
    const peer = (1 - self) as 0 | 1;
    return {
      postMessage(message: unknown) {
        if (!open) return;
        // A byte transport carries bytes and nothing else. Anything else here
        // is the codec breaking its contract, and must not be papered over.
        if (!(message instanceof Uint8Array)) {
          throw new TypeError(
            `bytePipePair: expected Uint8Array on the wire, got ${Object.prototype.toString.call(message)}`,
          );
        }
        // Copy, because a real transport does not share the sender's buffer.
        const copy = message.slice();
        setTimeout(() => {
          if (!open) return;
          const event = new MessageEvent("message", { data: copy });
          for (const listener of [...listeners[peer]]) {
            try {
              void listener(event);
            } catch {
              /* one consumer's fault is not the pipe's */
            }
          }
        }, 0);
      },
      addEventListener(_type: "message", listener: MessageListener) {
        listeners[self].add(listener);
      },
      removeEventListener(_type: "message", listener: MessageListener) {
        listeners[self].delete(listener);
      },
    };
  };

  return {
    a: make(0),
    b: make(1),
    close() {
      open = false;
      listeners[0].clear();
      listeners[1].clear();
    },
  };
}

/**
 * The C1 stack: a byte pipe, `multiplexPort` with `msgpackCodec` on each end,
 * a virtual port per call, `duplexOverPort` on that port.
 *
 * `PairTuning` is ignored, exactly as the `webrun-rpc` new-stack pair ignores
 * it: this design has no credit window to shrink, so **L6 here is an integrity
 * check only** — its green says the body round-trips and says nothing about
 * flow control. L6's redefinition is spec D17, sequenced into Plan C3 because
 * five adapters still run it against `emulateMux`, where the window is real.
 * This stack's flow-control coverage lives in `webrun-rpc`'s own
 * `duplex-over-port-timeout` and `duplex-over-port-hostile` suites.
 */
const makeBytePair: MakePair = async () => {
  const pipe = bytePipePair();
  let clientMux: PortMux | undefined;
  let serverMux: PortMux | undefined;

  return {
    async connect() {
      clientMux ??= multiplexPort(pipe.a, { codec: msgpackCodec, side: "initiator" });
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
      const mux = multiplexPort(pipe.b, {
        codec: msgpackCodec,
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
      pipe.close();
    },
  };
};

describeDuplexAdapter("msgpackCodec over an in-process byte pipe", makeBytePair);
