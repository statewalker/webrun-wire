import type { Connection, Libp2p, PeerId } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { deserialize, serialize } from "@statewalker/webrun-msgpack";
import { overPorts, connect as portConnect, serve as portServe } from "@statewalker/webrun-rpc";
import type { Connect, Duplex, Serve, ValueCodec } from "@statewalker/webrun-streams";
import { legacyConnect, legacyServeConnections } from "./legacy-connect-serve.js";
import { type InboundPortInfo, openLibp2pPortMux } from "./port-mux.js";
import {
  type ConnectionContext,
  DEFAULT_PROTOCOL,
  type ServeConnectionsHandler,
} from "./shared.js";

export { type ConnectionContext, DEFAULT_PROTOCOL, type ServeConnectionsHandler };

/**
 * 4 MiB: the port window `connect`/`serve` grant unless told otherwise — the
 * most one call moves per round trip, and the most a producer runs ahead of a
 * consumer that stopped reading (statewalker/webrun-wire#153).
 *
 * A call moves at most `window / RTT`, so the window should be at least the
 * link's bandwidth-delay product: 4 MiB covers 200 Mbit/s at 100 ms
 * (2.5 MB). Raise it for faster or longer links; lower it (not below 64 KiB)
 * to bound memory per call more tightly where the BDP is small — a window far
 * above the bottleneck's queue only adds latency (bufferbloat).
 */
export const DEFAULT_WINDOW = 4 * 1024 * 1024;

/**
 * The protocol a call's stream negotiates for `connect`/`serve` configured
 * with `protocol`: `protocol` with `/ports` appended, and `/window` after it
 * when both ends run the window (always, between two releases from this one
 * on). `protocol` itself is the deprecated protocol, still served, and dialled
 * when a peer refuses this one.
 */
export function portProtocolOf(protocol: string): string {
  return `${protocol}/ports`;
}

/** What a call's messages are on the wire: msgpack, as `webrun-rpc`'s stream tier posts them. */
const codec: ValueCodec = { encode: serialize, decode: deserialize };

export interface ConnectLibp2pParams {
  node: Libp2p;
  peer: PeerId | Multiaddr;
  /**
   * The protocol id both ends are configured with; defaults to
   * {@link DEFAULT_PROTOCOL}. Calls negotiate {@link portProtocolOf} it, and
   * fall back to it (the deprecated protocol) against an older server.
   */
  protocol?: string;
  /**
   * The port window in bytes (default {@link DEFAULT_WINDOW}, at least 64 KiB):
   * the most this end holds of a call's response delivered and not yet read.
   * The server's window bounds what a call sends ahead of it. Size it at
   * least to the bandwidth-delay product of the link (see
   * {@link DEFAULT_WINDOW}).
   */
  window?: number;
  /**
   * Per-call inactivity timeout in ms, reset by any chunk in either direction
   * (`webrun-rpc`'s `timeout`). Unset, the default, means none: a slow
   * consumer is throttled, never failed.
   */
  timeout?: number;
  /**
   * The largest frame accepted from the peer on a call's stream; past it, or
   * on a malformed frame header, the call fails and the stream is aborted.
   * Default 64 MiB.
   */
  maxFrameBytes?: number;
  /**
   * How many outgoing streams for the calls' protocol libp2p allows to be open
   * at the same time on one connection; passed through to `node.dialProtocol`.
   * Left unset, libp2p's own default (64) applies.
   */
  maxOutboundStreams?: number;
  /**
   * Opt-in to dialing over a connection with limits on how much data can be
   * transferred or how long it can be open for (e.g. a relayed circuit);
   * passed through to `node.dialProtocol`. Left unset, libp2p refuses to open
   * the calls' streams on such a connection — this package does not decide
   * that trade-off for the caller, it only exposes the knob.
   */
  runOnLimitedConnection?: boolean;
  /**
   * The deprecated protocol only (an older server): how long to wait for a
   * backpressured stream to drain before dropping the peer; defaults to
   * `DEFAULT_DRAIN_TIMEOUT_MS` (5 minutes).
   *
   * @deprecated Removed with the deprecated protocol, in the next release.
   */
  drainTimeoutMs?: number;
  /**
   * The deprecated protocol only (an older server): response bytes held while
   * the caller is not reading before the stream is paused (default 64 KiB).
   *
   * @deprecated Removed with the deprecated protocol, in the next release.
   */
  readHighWaterBytes?: number;
}

export interface ServeLibp2pParams {
  node: Libp2p;
  /**
   * The protocol id both ends are configured with; defaults to
   * {@link DEFAULT_PROTOCOL}. Calls arrive on {@link portProtocolOf} it; the
   * id itself is served too, for older callers (the deprecated protocol).
   */
  protocol?: string;
  /**
   * The port window in bytes (default {@link DEFAULT_WINDOW}, at least 64 KiB):
   * the most this end holds of a call's request delivered and not yet read by
   * the handler. See {@link ConnectLibp2pParams.window}.
   */
  window?: number;
  /** Per-call inactivity timeout in ms; see {@link ConnectLibp2pParams.timeout}. */
  timeout?: number;
  /** The largest frame accepted from the peer; see {@link ConnectLibp2pParams.maxFrameBytes}. */
  maxFrameBytes?: number;
  /**
   * How many incoming streams for each served protocol libp2p allows to be
   * open at the same time on one connection; passed through to
   * `node.handle`. Left unset, libp2p's own default (32) applies — past it, a
   * new inbound stream is reset rather than queued, so a caller with more
   * calls in flight starts seeing rejected calls above that count.
   */
  maxInboundStreams?: number;
  /**
   * How many outgoing streams for each served protocol libp2p allows to be
   * open at the same time on one connection; passed through to `node.handle`.
   * Left unset, libp2p's own default (64) applies.
   */
  maxOutboundStreams?: number;
  /**
   * Opt-in to accepting calls over a connection with limits on how much data
   * can be transferred or how long it can be open for (e.g. a relayed
   * circuit); passed through to `node.handle`.
   */
  runOnLimitedConnection?: boolean;
  /**
   * The deprecated protocol only (older callers): how long to wait for a
   * backpressured stream to drain before dropping the peer (default 5 minutes).
   *
   * @deprecated Removed with the deprecated protocol, in the next release.
   */
  drainTimeoutMs?: number;
  /**
   * The deprecated protocol only (older callers): request bytes held while the
   * handler is not reading before the stream is paused (default 64 KiB).
   *
   * @deprecated Removed with the deprecated protocol, in the next release.
   */
  readHighWaterBytes?: number;
}

/**
 * Caller-side: each `call(input)` is one port of a windowed native port mux
 * (`libp2pPortMux`): one libp2p stream negotiating {@link portProtocolOf}
 * `protocol` with `/window`, over which `webrun-rpc`'s stream tier runs the
 * call, pipelining up to the server's window per round trip. Streams are
 * opened through the early-stream gate, so a burst of calls on a fresh
 * connection does not kill its muxer.
 *
 * Against an older server, which refuses that protocol, the call falls back to
 * the deprecated protocol on `protocol` itself, and the node remembers that
 * for the connection, so later calls to that peer dial it directly. The
 * fallback is removed in the next release.
 */
export const connect: Connect<ConnectLibp2pParams> = async (params) => {
  const { node, peer, maxFrameBytes, maxOutboundStreams, runOnLimitedConnection } = params;
  const protocol = params.protocol ?? DEFAULT_PROTOCOL;
  const ports = await portConnect({
    mux: overPorts(() =>
      openLibp2pPortMux(
        {
          node,
          peer,
          codec,
          protocol: portProtocolOf(protocol),
          window: params.window ?? DEFAULT_WINDOW,
          maxMessageBytes: maxFrameBytes,
          maxOutboundStreams,
          runOnLimitedConnection,
        },
        undefined,
      ),
    ),
    timeout: params.timeout,
  });
  // The deprecated protocol, for a server that refuses the port protocol.
  const legacy = await legacyConnect({
    node,
    peer,
    protocol,
    drainTimeoutMs: params.drainTimeoutMs,
    readHighWaterBytes: params.readHighWaterBytes,
    maxFrameBytes,
    maxOutboundStreams,
    runOnLimitedConnection,
  });

  const call: Duplex = (input) => {
    if (isLegacyPeer(node, peer, protocol)) return legacy.call(input);
    return withFallback(
      ports.call(input),
      () => legacy.call(input),
      (err) => {
        if (!isUnsupportedProtocol(err)) return false;
        markLegacyPeer(node, peer, protocol);
        return true;
      },
    );
  };

  return {
    call,
    async close() {
      await Promise.allSettled([ports.close(), legacy.close()]);
    },
  };
};

/**
 * Server-side: serves each call as one port of a windowed native port mux
 * (`<protocol>/ports`, with and without `/window`), and runs `handler` on it.
 * Older callers are still answered on `protocol` itself, the deprecated
 * protocol, until the next release. Identity-unaware; use `serveConnections`
 * when the handler needs to know who is calling.
 */
export const serve: Serve<ServeLibp2pParams> = async (params, handler: Duplex) =>
  serveConnections(params, () => handler);

/**
 * Like `serve`, but the handler is built per call and is told which peer
 * libp2p proved on the connection the call came on.
 */
export async function serveConnections(
  params: ServeLibp2pParams,
  makeHandler: ServeConnectionsHandler,
): Promise<() => Promise<void>> {
  const { node, maxFrameBytes, maxInboundStreams, maxOutboundStreams, runOnLimitedConnection } =
    params;
  const protocol = params.protocol ?? DEFAULT_PROTOCOL;

  // The connection of the port being accepted. The stream tier installs the
  // handler synchronously, inside the mux's `onPort` (`webrun-rpc`'s `serve`
  // calls `serveDuplexOverPort`, which calls the handler at once), so the
  // handler below reads the info of its own port.
  let arriving: InboundPortInfo | undefined;
  const stopPorts = await portServe(
    {
      mux: overPorts((onPort) =>
        openLibp2pPortMux(
          {
            node,
            codec,
            protocol: portProtocolOf(protocol),
            window: params.window ?? DEFAULT_WINDOW,
            maxMessageBytes: maxFrameBytes,
            maxInboundStreams,
            maxOutboundStreams,
            runOnLimitedConnection,
            onPort:
              onPort &&
              ((port, info) => {
                arriving = info;
                try {
                  return onPort(port, info);
                } finally {
                  arriving = undefined;
                }
              }),
          },
          undefined,
        ),
      ),
      timeout: params.timeout,
    },
    (input) => {
      const info = arriving;
      if (!info) throw new Error("webrun-streams-libp2p: a call arrived without its connection");
      return makeHandler({ remotePeer: info.remotePeer })(input);
    },
  );

  // The deprecated protocol, for older callers.
  let stopLegacy: () => Promise<void>;
  try {
    stopLegacy = await legacyServeConnections(
      {
        node,
        protocol,
        drainTimeoutMs: params.drainTimeoutMs,
        readHighWaterBytes: params.readHighWaterBytes,
        maxFrameBytes,
        maxInboundStreams,
        maxOutboundStreams,
        runOnLimitedConnection,
      },
      makeHandler,
    );
  } catch (err) {
    await stopPorts();
    throw err;
  }

  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await Promise.all([stopPorts(), stopLegacy()]);
  };
}

/** Whether `err` says the peer speaks none of the protocols dialled. */
function isUnsupportedProtocol(err: unknown): boolean {
  return err instanceof Error && err.name === "UnsupportedProtocolError";
}

/**
 * `primary`, except that when its first `next()` rejects with an error
 * `fallBack` accepts — the port protocol refused, before any of the input was
 * read — the call runs on `fallback()` instead. `return()` and `throw()` go
 * straight to the current call, so a consumer that gives up on a pending
 * `next()` is heard at once, as by the call itself.
 */
function withFallback(
  primary: AsyncGenerator<Uint8Array>,
  fallback: () => AsyncGenerator<Uint8Array>,
  fallBack: (err: unknown) => boolean,
): AsyncGenerator<Uint8Array> {
  let current = primary;
  let settled = false;
  const wrapped: Pick<
    AsyncGenerator<Uint8Array>,
    "next" | "return" | "throw" | typeof Symbol.asyncIterator
  > = {
    async next(...args: [] | [unknown]) {
      if (settled) return current.next(...args);
      try {
        const result = await current.next(...args);
        settled = true;
        return result;
      } catch (err) {
        if (settled || !fallBack(err)) {
          settled = true;
          throw err;
        }
        settled = true;
        current = fallback();
        return current.next(...args);
      }
    },
    return(value) {
      settled = true;
      return current.return(value);
    },
    throw(error) {
      settled = true;
      return current.throw(error);
    },
    [Symbol.asyncIterator]() {
      return wrapped as AsyncGenerator<Uint8Array>;
    },
  };
  // `await using` ends the call as leaving a `for await` early does.
  const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;
  if (asyncDispose) {
    Object.defineProperty(wrapped, asyncDispose, {
      value: async () => {
        await wrapped.return(undefined);
      },
      configurable: true,
      writable: true,
    });
  }
  return wrapped as AsyncGenerator<Uint8Array>;
}

/**
 * Peers known to refuse the port protocol, per local node, by peer and
 * protocol: the connection the refusal came on (`null` when the node cannot
 * tell), so a peer that restarts upgraded is probed again on its next
 * connection.
 */
const legacyPeers = new WeakMap<Libp2p, Map<string, { connection: Connection | null }>>();

const legacyKey = (peer: PeerId | Multiaddr, protocol: string) => `${peer.toString()} ${protocol}`;

function isLegacyPeer(node: Libp2p, peer: PeerId | Multiaddr, protocol: string): boolean {
  const peers = legacyPeers.get(node);
  const mark = peers?.get(legacyKey(peer, protocol));
  if (!mark) return false;
  if (mark.connection == null || mark.connection.status === "open") return true;
  peers?.delete(legacyKey(peer, protocol));
  return false;
}

function markLegacyPeer(node: Libp2p, peer: PeerId | Multiaddr, protocol: string): void {
  let peers = legacyPeers.get(node);
  if (!peers) {
    peers = new Map();
    legacyPeers.set(node, peers);
  }
  peers.set(legacyKey(peer, protocol), { connection: connectionTo(node, peer) });
}

/**
 * The open connection to `peer`, when `node` can list its connections (a
 * narrow stand-in may offer only `dialProtocol`).
 */
function connectionTo(node: Libp2p, peer: PeerId | Multiaddr): Connection | null {
  if (typeof node.getConnections !== "function") return null;
  const target = peer.toString();
  return (
    node
      .getConnections()
      .find(
        (c) =>
          c.status === "open" &&
          (c.remotePeer.toString() === target ||
            c.remoteAddr.toString() === target ||
            target.endsWith(`/p2p/${c.remotePeer.toString()}`)),
      ) ?? null
  );
}
