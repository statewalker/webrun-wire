import type { Connect, Duplex, Serve } from "@statewalker/webrun-streams";
import {
  type DuplexOverPortOptions,
  duplexOverPort,
  serveDuplexOverPort,
} from "./duplex-over-port.js";
import type { MessageTarget } from "./message-target.js";
import { multiplexPort } from "./multiplex-port.js";
import type { PortCodec, PortMux } from "./port-types.js";

/**
 * Announced with every port this pair opens. Layer 1 never reads `meta` — it is
 * here so a peer running something else over the same multiplexer can tell a
 * stream port from whatever else it hands out, and so a packet capture says
 * what the port is for.
 */
const STREAM_META = { kind: "stream" } as const;

/** What a mux calls when the peer opens a port. `false` rejects it. */
export type OnPort = (port: MessageTarget, meta?: unknown) => boolean | undefined;

/**
 * A source of ports, built around the handler that will answer them.
 *
 * WHY A FACTORY AND NOT A `PortMux`. Every mux decides accept-or-reject
 * **synchronously**, inside the `open` envelope, and tells the peer on the
 * spot — `multiplexPort` posts `{type:"close", reason:"rejected"}` before
 * returning. There is no "decide later", and layer 1 refuses to queue what it
 * cannot deliver ("Drop, never queue").
 *
 * So a mux handed over already built has a window between its construction and
 * its handler being attached, and a port arriving in that window is rejected
 * outright — measured: zero messages delivered, and the peer told `rejected`
 * for a call that was merely early. A factory closes the window by
 * construction: the mux cannot exist before the thing that answers it.
 *
 * `connect` passes no handler, which is how a caller declines inbound ports.
 * The same factory therefore serves both sides, and whichever of them called
 * it owns the mux and closes it.
 */
export type PortMuxFactory = (onPort?: OnPort) => PortMux | Promise<PortMux>;

export interface PortParams {
  /**
   * Where ports come from. See {@link PortMuxFactory}, and `overPipe` /
   * `overPorts` for the two this package ships.
   *
   * This used to be a `MessageTarget` plus `side` and a credit window, which
   * forced one strategy — an id table — on every transport. A libp2p
   * connection multiplexes already, so that stacked two multiplexers with no
   * way to tell which one stalled; a transferable boundary moves real ports
   * and needs no table at all. The strategy belongs to whoever knows the
   * transport, which is never this file.
   */
  mux: PortMuxFactory;
  /** Per-stream inactivity timeout in ms, reset by any chunk in either direction.
   *
   * Unset — the default — means no timeout at all: a slow consumer is
   * throttled, never failed. Set it on the side that must not hang. */
  timeout?: number;
}

/**
 * One port source in, one caller `Duplex` out.
 *
 * A call is a port: the mux allocates one, `duplexOverPort` runs the single
 * invocation on it, and closing the stream closes the port. No stream ids, no
 * framing and no credit accounting live here — the mux owns the first, and
 * `duplexOverPort` owns the one-chunk window that makes memory bounded.
 */
export const connect: Connect<PortParams> = async ({ mux: factory, timeout }) => {
  // No handler: a caller answers no inbound calls, and an unexpected `open`
  // from the peer is refused rather than silently accepted and then starved.
  const mux = await factory();
  const streamOptions: DuplexOverPortOptions = { maxMessageSize: mux.maxMessageSize, timeout };

  const call: Duplex = (input) =>
    // The port is opened on the consumer's first pull, not when `call` is
    // invoked. A caller that builds a stream and then drops it without
    // iterating therefore costs the peer nothing — under eager opening it
    // would burn a port (and over libp2p, a whole stream) for a call that
    // never arrives.
    (async function* () {
      const port = await mux.openPort(STREAM_META);
      // `yield*` and not a hand-rolled pump: delegation already forwards
      // `return()` and `throw()` into `duplexOverPort`'s generator, which is
      // exactly the cancellation path `Duplex` specifies.
      yield* duplexOverPort(port, streamOptions)(input);
    })();

  return {
    call,
    async close() {
      await mux.close();
    },
  };
};

/**
 * One port source in, `handler` serving every call that arrives on it.
 *
 * Each inbound port is one invocation, so the factory's `onPort` is the accept
 * loop: it installs `handler` on the new port and nothing else. The returned
 * teardown abandons the streams still running *before* dropping the mux, so
 * the peer's callers reject with "the peer abandoned the stream" instead of
 * parking forever on a port that has silently gone inert — layer 1's close is
 * not observable to layer 2, which is why the notice has to be posted
 * deliberately.
 */
export const serve: Serve<PortParams> = async ({ mux: factory, timeout }, handler) => {
  // Live streams only. A set that merely accumulated one entry per call would
  // grow for the life of the connection — the same unbounded retention this
  // stack exists to avoid, just moved from bytes to closures — so each entry is
  // dropped the moment its handler is finished with.
  const live = new Set<() => void>();
  let streamOptions: DuplexOverPortOptions = { timeout };

  const mux = await factory((port) => {
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
    off = serveDuplexOverPort(port, tracked, streamOptions);
    // `serveDuplexOverPort` invokes the handler synchronously. The generator
    // body above is lazy, so today it cannot have finished by the time `off`
    // exists — but if it ever could, the `finally` would have run with `off`
    // still unassigned and this line would add back an entry nothing will
    // ever remove. The flag costs a word and closes that door.
    if (!finished) live.add(off);
  });

  // Only knowable after the factory has run, and the first inbound port cannot
  // arrive before it returns — the mux does not exist to receive one yet.
  streamOptions = { maxMessageSize: mux.maxMessageSize, timeout };

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
        // mux close below.
      }
    }
    await mux.close();
  };
};

export interface OverPipeOptions {
  /** How envelopes are placed on the pipe. `structuredCodec` for a `MessagePort`. */
  codec: PortCodec;
  /**
   * Id parity. The initiator allocates even ids, the responder odd, so both
   * ends may open concurrently with no negotiation. The two ends of one pair
   * must disagree, or their ids collide.
   */
  side?: "initiator" | "responder";
  /** Ceiling on concurrently open ports. Bounds the id table only. */
  maxPorts?: number;
  /**
   * Largest payload one message may carry, if the pipe imposes a limit.
   * Bodies are split to fit. Leave at least 256 bytes of margin below the
   * transport's real ceiling — see `PortMuxOptions.maxMessageSize`.
   */
  maxMessageSize?: number;
}

/**
 * Ports over ONE PIPE OF BYTES — a `MessagePort`, a worker, a WebSocket.
 *
 * There is no second port to be had, so `multiplexPort`'s id table invents
 * them. Use this when the transport gives you exactly one channel.
 */
export function overPipe(pipe: MessageTarget, options: OverPipeOptions): PortMuxFactory {
  return (onPort) => multiplexPort(pipe, { ...options, onPort });
}

/**
 * Ports from a source that already has them — a transferable boundary, or a
 * transport that multiplexes on its own (libp2p's yamux, say).
 *
 * A pass-through, so an adapter that builds its own `PortMux` plugs in without
 * this package learning what that transport is. It exists to make the
 * three-way choice legible at the call site rather than to do work:
 *
 * ```ts
 * await serve({ mux: overPorts((onPort) => libp2pPortMux({ node, onPort })) }, handler);
 * ```
 */
export function overPorts(factory: PortMuxFactory): PortMuxFactory {
  return factory;
}
