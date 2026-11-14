import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { describeDuplexAdapter, type MakePair } from "@statewalker/webrun-streams-conformance";
import { byteChannelFromDataChannel, byteChannelFromRoom } from "../src/byte-channel.js";
import { messageTargetOverByteChannel } from "../src/message-target.js";
import type { ByteChannel } from "../src/types.js";
import { MockRoom, RoomBus } from "./mocks/room-bus.js";

/**
 * The pipe this package hands back (`messageTargetOverByteChannel` over a
 * `ByteChannel`) under the conformance suite, with the port stack on top as
 * every adapter runs it: `overPipe` with `msgpackCodec` invents the ports, and
 * `webrun-rpc`'s `connect` / `serve` run one call per port. Both of the
 * package's channel builders are covered, over in-process stand-ins for the
 * transports (Node has no `RTCDataChannel` and no LiveKit server):
 *
 * - `byteChannelFromDataChannel`, over two data channels joined by a
 *   `MessageChannel` (what `PeerManager`, `QrSignaling` and `PeerConnection`
 *   hand back);
 * - `byteChannelFromRoom`, over the in-memory room bus (what `RoomManager`
 *   hands back).
 *
 * L6 (spec D17): the port stack withholds a chunk's confirmation until the
 * consumer has pulled past it, so a producer is never more than a chunk
 * ahead; the pair declares one 4 KiB chunk.
 */

/** A connected pair of channels; `serve` gets the responder's end. */
type Link = () => [caller: ByteChannel, responder: ByteChannel];

/** Two `RTCDataChannel` stand-ins joined by a `MessageChannel`; closing either closes both. */
class LinkedDataChannel extends EventTarget {
  binaryType = "blob";
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer?: LinkedDataChannel;
  constructor(private readonly port: MessagePort) {
    super();
    port.onmessage = (e: MessageEvent) => {
      if (this.readyState === "open")
        this.dispatchEvent(new MessageEvent("message", { data: e.data }));
    };
  }
  send(data: ArrayBufferView): void {
    if (this.readyState !== "open") throw new DOMException("channel closed", "InvalidStateError");
    const view = data as Uint8Array;
    // A real data channel copies what it sends; the receiver gets an ArrayBuffer.
    this.port.postMessage(view.slice().buffer);
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    // Let what is already posted arrive first, as SCTP delivers before the close.
    setTimeout(() => {
      this.port.close();
      this.dispatchEvent(new Event("close"));
      this.peer?.close();
    }, 0);
  }
}

const dataChannelLink: Link = () => {
  const { port1, port2 } = new MessageChannel();
  const a = new LinkedDataChannel(port1);
  const b = new LinkedDataChannel(port2);
  a.peer = b;
  b.peer = a;
  return [
    byteChannelFromDataChannel(a as unknown as RTCDataChannel),
    byteChannelFromDataChannel(b as unknown as RTCDataChannel),
  ];
};

const roomLink: Link = () => {
  const bus = new RoomBus();
  const caller = new MockRoom("caller", bus);
  const responder = new MockRoom("responder", bus);
  void caller.connect();
  void responder.connect();
  return [byteChannelFromRoom(caller, "responder"), byteChannelFromRoom(responder, "caller")];
};

function makeSignalingPair(link: Link, ownMaxMessageSize?: number): MakePair {
  return async (tuning) => {
    const maxMessageSize = tuning?.maxMessageSize ?? ownMaxMessageSize;
    let handler: Duplex | undefined;
    const teardowns = new Set<() => Promise<void>>();
    const pending = new Set<Promise<unknown>>();
    const accept = (channel: ByteChannel): void => {
      if (!handler) {
        channel.close();
        return;
      }
      const {
        target,
        signal,
        maxMessageSize: own,
      } = messageTargetOverByteChannel(channel, {
        maxMessageSize,
      });
      const started = serve(
        {
          mux: overPipe(target, {
            codec: msgpackCodec,
            side: "responder",
            signal,
            maxMessageSize: own,
          }),
        },
        handler,
      ).then((teardown) => {
        teardowns.add(teardown);
        signal.addEventListener("abort", () => teardowns.delete(teardown), { once: true });
      });
      pending.add(started);
      void started.finally(() => pending.delete(started));
    };
    return {
      runAheadBytes: 4096,
      async connect() {
        const [caller, responder] = link();
        accept(responder);
        const {
          target,
          signal,
          maxMessageSize: own,
        } = messageTargetOverByteChannel(caller, {
          maxMessageSize,
        });
        return connect({
          mux: overPipe(target, {
            codec: msgpackCodec,
            side: "initiator",
            signal,
            maxMessageSize: own,
          }),
        });
      },
      async serve(h) {
        handler = h;
        return async () => {
          handler = undefined;
          await Promise.allSettled([...pending]);
          for (const teardown of [...teardowns]) await teardown();
        };
      },
      async close() {
        handler = undefined;
        await Promise.allSettled([...pending]);
        for (const teardown of [...teardowns]) await teardown();
      },
    };
  };
}

describeDuplexAdapter(
  "webrun-streams-signaling: messageTargetOverByteChannel over byteChannelFromDataChannel",
  makeSignalingPair(dataChannelLink),
);

// A room channel's payload ceiling, as `webrun-streams-livekit` uses (see DEFAULT_MAX_MESSAGE_SIZE).
describeDuplexAdapter(
  "webrun-streams-signaling: messageTargetOverByteChannel over byteChannelFromRoom",
  makeSignalingPair(roomLink, 12 * 1024),
);
