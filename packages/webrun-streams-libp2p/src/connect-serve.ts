import type {
  Connection,
  DialProtocolOptions,
  Libp2p,
  PeerId,
  Stream,
  StreamHandlerOptions,
} from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import type { Connect, Duplex, Serve } from "@statewalker/webrun-streams";
import {
  closeStream,
  DEFAULT_READ_HIGH_WATER_BYTES,
  duplexOverStream,
  PeerGoneError,
} from "./duplex-over-stream.js";
import { openGatedStream } from "./stream-gate.js";

export const DEFAULT_PROTOCOL = "/webrun-streams/1.0.0";

export interface ConnectLibp2pParams {
  node: Libp2p;
  peer: PeerId | Multiaddr;
  /** libp2p protocol id; defaults to `/webrun-streams/1.0.0`. */
  protocol?: string;
  /**
   * How long to wait for a backpressured stream to drain before dropping the
   * peer; defaults to `DEFAULT_DRAIN_TIMEOUT_MS` (5 minutes).
   */
  drainTimeoutMs?: number;
  /**
   * Response bytes held while the caller is not reading before the stream is
   * paused; see `DuplexOverStreamOptions.readHighWaterBytes` (default 64 KiB).
   */
  readHighWaterBytes?: number;
  /**
   * How many outgoing streams for this protocol libp2p allows to be open at
   * the same time on one connection; passed through to `node.dialProtocol`.
   * Left unset, libp2p's own default (64) applies.
   */
  maxOutboundStreams?: number;
  /**
   * Opt-in to dialing over a connection with limits on how much data can be
   * transferred or how long it can be open for (e.g. a relayed circuit);
   * passed through to `node.dialProtocol`. Left unset, libp2p refuses to open
   * this protocol's stream on such a connection — this package does not
   * decide that trade-off for the caller, it only exposes the knob.
   */
  runOnLimitedConnection?: boolean;
}

export interface ServeLibp2pParams {
  node: Libp2p;
  /** libp2p protocol id; defaults to `/webrun-streams/1.0.0`. */
  protocol?: string;
  /**
   * How long to wait for a backpressured stream to drain before dropping the
   * peer; defaults to `DEFAULT_DRAIN_TIMEOUT_MS` (5 minutes). This is the only
   * bound on a peer that requests something and then stops reading without
   * closing, since the caller-side `.return`/abort escape does not exist here.
   */
  drainTimeoutMs?: number;
  /**
   * Request bytes held while the handler is not reading before the stream is
   * paused; see `DuplexOverStreamOptions.readHighWaterBytes` (default 64 KiB).
   */
  readHighWaterBytes?: number;
  /**
   * How many incoming streams for this protocol libp2p allows to be open at
   * the same time on one connection; passed through to `node.handle`. Left
   * unset, libp2p's own default (32) applies — past it, a new inbound stream
   * is reset rather than queued, so a caller that opens one stream per
   * in-flight request will start seeing rejected calls above that count.
   */
  maxInboundStreams?: number;
  /**
   * How many outgoing streams for this protocol libp2p allows to be open at
   * the same time on one connection; passed through to `node.handle`. Left
   * unset, libp2p's own default (64) applies.
   */
  maxOutboundStreams?: number;
  /**
   * Opt-in to accepting streams for this protocol over a connection with
   * limits on how much data can be transferred or how long it can be open
   * for (e.g. a relayed circuit); passed through to `node.handle`. Left
   * unset, libp2p refuses to open this protocol's stream on such a
   * connection — this package does not decide that trade-off for the
   * consumer, it only exposes the knob.
   */
  runOnLimitedConnection?: boolean;
}

/**
 * Builds the options object passed to `node.dialProtocol`/`node.handle`,
 * omitting any field the caller didn't supply rather than setting it to
 * `undefined` — so an unset field falls back to libp2p's own default instead
 * of an explicit `undefined` overriding it.
 */
function definedOptions<T extends Record<string, unknown>>(fields: T): Partial<T> | undefined {
  const options: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const value = fields[key];
    if (value !== undefined) {
      options[key] = value;
      any = true;
    }
  }
  return any ? options : undefined;
}

/**
 * Caller-side: each `call(input)` opens a new libp2p `Stream` via
 * `node.dialProtocol(peer, [protocol])` and runs the call over it.
 */
export const connect: Connect<ConnectLibp2pParams> = async ({
  node,
  peer,
  protocol,
  drainTimeoutMs,
  readHighWaterBytes,
  maxOutboundStreams,
  runOnLimitedConnection,
}) => {
  const proto = protocol ?? DEFAULT_PROTOCOL;
  const dialOptions: DialProtocolOptions | undefined = definedOptions({
    maxOutboundStreams,
    runOnLimitedConnection,
  });
  const open = new Set<Stream>();

  // A burst of calls must not reach the remote before its muxer is ready.
  //
  // When there is no connection to the peer yet, every call dials it and they
  // all share the one connection libp2p establishes. Their streams can arrive
  // while the REMOTE side is still upgrading that connection, and yamux counts
  // those "early streams": past `maxEarlyStreams` (10 by default) it aborts the
  // whole muxer, so every stream on the connection dies — the remote sees EOF
  // during protocol negotiation, this side sees `StreamResetError`. Raising the
  // limit on our own nodes would not help against any other libp2p peer.
  //
  // So until one stream has negotiated its protocol on an open connection, the
  // calls open their streams one at a time: a completed negotiation means the
  // remote has finished its upgrade, and from then on streams are not early and
  // open concurrently. If that connection closes, the next burst is gated again.
  // The state is shared by every connect() to the same peer from the same node
  // (callers often connect() per request), since they all share its connection.
  const openStream = (): Promise<Stream> => openGatedStream(node, peer, proto, dialOptions);

  const call: Duplex = (input) => {
    let streamRef: Stream | null = null;
    const gen = (async function* () {
      const stream = await openStream();
      streamRef = stream;
      open.add(stream);
      let sourceCompleted = false;
      try {
        yield* duplexOverStream(stream, input, {
          drainTimeoutMs,
          readHighWaterBytes,
          onSourceCompleted: () => {
            sourceCompleted = true;
          },
        });
      } finally {
        open.delete(stream);
        if (sourceCompleted) {
          // Natural end on both sides. Graceful close, bounded so a peer
          // that stops reading without resetting can't hang this forever.
          await closeStream(stream);
        }
        // Else: consumer cancelled. The .return override below has already
        // called stream.abort to send RST; nothing more to do here.
      }
    })();

    // Send a yamux RST to peer when the consumer cancels (i.e., calls .return
    // on this generator). Doing it here is essential because by the time the
    // generator's own finally runs, the for-await teardown chain has already
    // marked the stream's status as `closed` — and AbstractStream.abort is a
    // no-op on closed streams.
    const origReturn = gen.return.bind(gen);
    gen.return = async (value: unknown) => {
      if (streamRef) {
        try {
          streamRef.abort(new Error("call cancelled"));
        } catch {
          /* ignore */
        }
      }
      return origReturn(value as undefined);
    };

    return gen;
  };
  return {
    call,
    async close() {
      for (const s of open) {
        try {
          s.abort(new Error("connection close"));
        } catch {
          /* ignore */
        }
      }
    },
  };
};

/**
 * Server-side: registers `node.handle(protocol, ...)`. Each inbound stream is
 * wrapped as a `Duplex` and handed to `handler`. Identity-unaware; use
 * `serveConnections` when the handler needs to know who is calling.
 */
export const serve: Serve<ServeLibp2pParams> = async (params, handler: Duplex) =>
  serveConnections(params, () => handler);

/** What the serving side knows about the connection a stream arrived on. */
export interface ConnectionContext {
  /**
   * The peer id libp2p's Noise handshake proved for this connection. This is
   * the only identity claim on the serving side that cannot be forged by the
   * request payload.
   */
  remotePeer: PeerId;
}

/**
 * Builds a handler for one inbound connection. Called once per stream, so the
 * connection stays reachable in the returned Duplex's closure — `Duplex` is
 * bytes-only (ADR-0004) and gains no new parameter.
 */
export type ServeConnectionsHandler = (context: ConnectionContext) => Duplex;

/**
 * Like `serve`, but the handler is built per inbound stream and is told which
 * peer libp2p proved on that connection.
 */
export async function serveConnections(
  {
    node,
    protocol,
    drainTimeoutMs,
    readHighWaterBytes,
    maxInboundStreams,
    maxOutboundStreams,
    runOnLimitedConnection,
  }: ServeLibp2pParams,
  makeHandler: ServeConnectionsHandler,
): Promise<() => Promise<void>> {
  const proto = protocol ?? DEFAULT_PROTOCOL;
  const handleOptions: StreamHandlerOptions | undefined = definedOptions({
    maxInboundStreams,
    maxOutboundStreams,
    runOnLimitedConnection,
  });

  const onStream = (stream: Stream, connection: Connection): void => {
    // The caller sent its whole request; a stream that dies after that is a
    // caller that stopped reading the response — ordinary, not a fault.
    let requestComplete = false;
    void (async () => {
      const handler = makeHandler({ remotePeer: connection.remotePeer });
      const inputQueue = makeInputQueue(readHighWaterBytes ?? DEFAULT_READ_HIGH_WATER_BYTES);
      // once the handler's output has ended, input it never started to read is
      // dropped instead of waited for (input it is reading, perhaps in the
      // background, keeps flowing at its pace)
      const output = endsWith(handler(inputQueue.iter()), () => inputQueue.abandon());
      try {
        for await (const chunk of duplexOverStream(stream, output, {
          drainTimeoutMs,
          readHighWaterBytes,
          onPeerInputEnd: (err) => {
            if (err === undefined) requestComplete = true;
            inputQueue.done(err);
          },
        })) {
          // past readHighWaterBytes queued for the handler, the next chunk is
          // read only once it took this one: a handler that stops reading
          // pauses the stream (see readHighWaterBytes)
          await inputQueue.push(chunk);
        }
      } finally {
        inputQueue.done();
        await closeStream(stream);
      }
    })().catch((err: unknown) => {
      // One inbound stream failing must not take down the process serving
      // every other peer. `duplexOverStream` rejects on the read side
      // whenever the peer sends an ERROR frame or resets mid-request — which
      // happens in ordinary use, not just under attack (a browser tab closed
      // mid-request resets its streams). Without this catch that rejection is
      // unhandled, and Node's default for `unhandledRejection` is to
      // terminate. Logged rather than rethrown, and never rethrown from here:
      // there is no caller left to receive it.
      if (requestComplete && err instanceof PeerGoneError) return;
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[webrun-streams-libp2p] serve: inbound stream on protocol ${proto} failed: ${e.message}`,
        e,
      );
    });
  };

  await node.handle(proto, onStream, handleOptions);

  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await node.unhandle(proto);
  };
}

/** `source`, calling `onEnd` once when it ends, fails or is returned. */
function endsWith(
  source: AsyncIterable<Uint8Array>,
  onEnd: () => void,
): AsyncGenerator<Uint8Array> {
  return (async function* () {
    try {
      yield* source;
    } finally {
      onEnd();
    }
  })();
}

interface InputQueue {
  iter(): AsyncGenerator<Uint8Array>;
  /**
   * resolves at once while the bytes queued for the handler stay within the
   * limit, else once the handler has read them back down to it (or will never
   * read on)
   */
  push(chunk: Uint8Array): Promise<void>;
  done(err?: Error): void;
  /**
   * the handler's output ended: if it never started reading its input, pending
   * and later chunks are dropped (an iterator started already is left to its
   * reader, which may go on reading after the output ended)
   */
  abandon(): void;
}

function makeInputQueue(limit: number): InputQueue {
  type Slot = { type: "value"; value: Uint8Array } | { type: "done"; err?: Error };
  const slots: Slot[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let pulled = false;
  let queued = 0;
  // the one push waiting for room (the serving loop awaits each push)
  let room: (() => void) | null = null;
  const makeRoom = (): void => {
    const r = room;
    room = null;
    r?.();
  };
  const release = (): void => {
    slots.length = 0;
    queued = 0;
    makeRoom();
  };
  return {
    iter(): AsyncGenerator<Uint8Array> {
      return (async function* () {
        if (closed) return; // abandoned before anyone read: the input was dropped
        pulled = true;
        try {
          while (true) {
            if (slots.length === 0) {
              await new Promise<void>((r) => {
                wake = r;
              });
              wake = null;
              continue;
            }
            const s = slots.shift() as Slot;
            if (s.type === "done") {
              if (s.err) throw s.err;
              return;
            }
            queued -= s.value.byteLength;
            if (queued <= limit) makeRoom();
            yield s.value;
          }
        } finally {
          closed = true;
          release();
        }
      })();
    },
    push(chunk: Uint8Array): Promise<void> {
      if (closed) return Promise.resolve();
      slots.push({ type: "value", value: chunk });
      queued += chunk.byteLength;
      wake?.();
      if (queued <= limit) return Promise.resolve();
      return new Promise<void>((resolve) => {
        room = resolve;
      });
    },
    done(err?: Error): void {
      if (closed) return;
      slots.push({ type: "done", err });
      wake?.();
    },
    abandon(): void {
      if (pulled) return;
      closed = true;
      release();
      wake?.();
    },
  };
}
