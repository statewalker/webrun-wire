import type { Connect, Duplex, Serve } from "@statewalker/webrun-streams";
import {
  type DuplexOverPortOptions,
  duplexOverPort,
  serveDuplexOverPort,
} from "./duplex-over-port.js";
import type { MessageTarget } from "./message-target.js";
import { multiplexPort } from "./multiplex-port.js";
import { structuredCodec } from "./structured-codec.js";

/**
 * Announced with every port this pair opens. Layer 1 never reads `meta` — it is
 * here so a peer running something else over the same multiplexer can tell a
 * stream port from whatever else it hands out, and so a packet capture says
 * what the port is for.
 */
const STREAM_META = { kind: "stream" } as const;

/**
 * What the port stack can actually be tuned by.
 *
 * This used to be `EmulateMuxOptions` — `mtu` plus `maxStreamBuffer`, a credit
 * window in bytes. Neither survives the move to `multiplexPort` +
 * `duplexOverPort`, and keeping them as accepted-and-ignored fields would be
 * worse than removing them: a caller who sets `maxStreamBuffer` to cap memory
 * would get a silent no-op where they expected a ceiling. There is no window to
 * size here because there is no window — a chunk's reply is withheld until the
 * consumer has pulled past it, so a producer is at most one chunk ahead and the
 * ceiling is one chunk per open port, by construction.
 */
export interface PortMuxParams {
  /**
   * Ceiling on concurrently open virtual ports, i.e. on concurrent in-flight
   * calls. Bounds the id table only. Defaults to `DEFAULT_MAX_PORTS`.
   */
  maxPorts?: number;
  /**
   * Largest **payload** one message may carry, if the underlying port imposes a
   * limit. Bodies are split to fit. It bounds the payload, **not the frame**
   * — the chunk wrapper, the call request, the port envelope and the codec are
   * all added on top — so leave at least 256 bytes of margin below the
   * transport's real ceiling; `PortMuxOptions.maxMessageSize` has the measured
   * numbers. Unset means no limit and no splitting, which is right for a real
   * `MessagePort`.
   */
  maxMessageSize?: number;
  /**
   * Per-stream inactivity timeout in ms, reset by any chunk in either
   * direction. Unset — the default — means no timeout at all: a slow consumer
   * is throttled, never failed. Set it on the side that must not hang, because
   * two abandonment cases are silent on the wire (see the README's table).
   */
  timeout?: number;
}

export interface PortParams {
  /**
   * Any `MessageTarget`, not only a real `MessagePort`. Nothing below this
   * line uses more than that surface, and narrowing it to `MessagePort` shut
   * out every virtual port — including one backed by a libp2p stream, which is
   * how a mesh hands out ports at all.
   */
  port: MessageTarget;
  /**
   * Port-id parity. Initiator allocates even ids, responder odd, so both ends
   * may open concurrently with no negotiation. Defaults to "initiator" on
   * `connect` and "responder" on `serve` — the two ends of one pair must
   * disagree, or their ids collide.
   */
  side?: "initiator" | "responder";
  /** See {@link PortMuxParams}. */
  mux?: PortMuxParams;
}

/**
 * One transport port in, one caller `Duplex` out.
 *
 * A call is a virtual port: `multiplexPort` allocates one, `duplexOverPort`
 * runs the single invocation on it, and closing the stream closes the port.
 * That is the whole of the multiplexing — no stream ids, no framing and no
 * credit accounting live here, because layer 1 already owns the id table and
 * layer 2 already owns the one-chunk window.
 */
export const connect: Connect<PortParams> = async ({ port, side, mux: params = {} }) => {
  const mux = multiplexPort(port, {
    codec: structuredCodec,
    side: side ?? "initiator",
    maxPorts: params.maxPorts,
    maxMessageSize: params.maxMessageSize,
    // No `onPort`: a caller answers no inbound calls. An unexpected `open` from
    // the peer is refused rather than silently accepted and then starved.
  });
  const streamOptions: DuplexOverPortOptions = {
    maxMessageSize: mux.maxMessageSize,
    timeout: params.timeout,
  };

  const call: Duplex = (input) =>
    // The port is opened on the consumer's first pull, not when `call` is
    // invoked. A caller that builds a stream and then drops it without
    // iterating therefore costs the peer nothing — under eager opening it
    // would have burned an id and left the responder holding a handler for a
    // call that never arrives.
    (async function* () {
      const streamPort = await mux.openPort(STREAM_META);
      // `yield*` and not a hand-rolled pump: delegation already forwards
      // `return()` and `throw()` into `duplexOverPort`'s generator, which is
      // exactly the cancellation path `Duplex` specifies.
      yield* duplexOverPort(streamPort, streamOptions)(input);
    })();

  return {
    call,
    async close() {
      await mux.close();
    },
  };
};

/**
 * One transport port in, `handler` serving every call that arrives on it.
 *
 * Each inbound port is one invocation, so `onPort` is the accept loop: it
 * installs `handler` on the new port and nothing else. The returned teardown
 * abandons the streams still running *before* dropping the transport, so the
 * peer's callers reject with "the peer abandoned the stream" instead of parking
 * forever on a port that has silently gone inert — layer 1's close is not
 * observable to layer 2, which is why the notice has to be posted deliberately.
 */
export const serve: Serve<PortParams> = async ({ port, side, mux: params = {} }, handler) => {
  const streamOptions: DuplexOverPortOptions = {
    maxMessageSize: params.maxMessageSize,
    timeout: params.timeout,
  };
  // Live streams only. A set that merely accumulated one entry per call would
  // grow for the life of the connection — the same unbounded retention this
  // stack exists to avoid, just moved from bytes to closures — so each entry is
  // dropped the moment its handler is finished with.
  const live = new Set<() => void>();

  const mux = multiplexPort(port, {
    codec: structuredCodec,
    side: side ?? "responder",
    maxPorts: params.maxPorts,
    maxMessageSize: params.maxMessageSize,
    onPort: (streamPort) => {
      let off: (() => void) | undefined;
      let finished = false;
      // Wrapping the handler's *output* is how this side learns a stream is
      // over: `sendChunks` drives that generator to completion, and an abort
      // reaches it as `return()` through `throughAbort`, so the `finally` runs
      // on every ending — normal exhaustion, handler throw, peer abort, local
      // teardown. `serveDuplexOverPort` reports no completion of its own.
      const tracked: Duplex = (input) =>
        (async function* () {
          try {
            yield* handler(input);
          } finally {
            finished = true;
            if (off) live.delete(off);
          }
        })();
      off = serveDuplexOverPort(streamPort, tracked, streamOptions);
      // `serveDuplexOverPort` invokes the handler synchronously. The generator
      // body above is lazy, so today it cannot have finished by the time `off`
      // exists — but if it ever could, the `finally` would have run with `off`
      // still unassigned and this line would add back an entry nothing will
      // ever remove. The flag costs a word and closes that door.
      if (!finished) live.add(off);
    },
  });

  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    for (const off of [...live]) {
      live.delete(off);
      try {
        off();
      } catch {
        // One stream's teardown failing must not strand the rest, nor the
        // multiplexer close below.
      }
    }
    await mux.close();
  };
};
