import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { Room } from "livekit-client";
import { inject } from "vitest";
import { messageTargetOverLiveKit } from "../src/message-target.js";
import { waitForPeer } from "./make-livekit-pair.js";

/**
 * The port stack over LiveKit: each (room, remote participant) is one pipe of
 * bytes (`messageTargetOverLiveKit`, reporting 12 KiB), `overPipe` with
 * `msgpackCodec` invents the ports, and `webrun-rpc`'s `connect` / `serve` run
 * one call per port. `PairTuning` is ignored: L6 is an integrity check on the
 * port stack until D17.
 */
export const makeLiveKitPortPair: MakePair = async () => {
  const url = inject("livekitUrl");
  const callerRoom = new Room();
  const responderRoom = new Room();
  try {
    await callerRoom.connect(url, inject("livekitTokenCaller"));
    await responderRoom.connect(url, inject("livekitTokenResponder"));
    await Promise.all([waitForPeer(callerRoom, "responder"), waitForPeer(responderRoom, "caller")]);
  } catch (err) {
    await Promise.allSettled([callerRoom.disconnect(), responderRoom.disconnect()]);
    throw err;
  }
  return {
    async connect() {
      const { target, signal, maxMessageSize } = messageTargetOverLiveKit(callerRoom, "responder");
      return connect({
        mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
      });
    },
    async serve(handler) {
      const { target, signal, maxMessageSize } = messageTargetOverLiveKit(responderRoom, "caller");
      return serve(
        {
          mux: overPipe(target, { codec: msgpackCodec, side: "responder", signal, maxMessageSize }),
        },
        handler,
      );
    },
    async close() {
      await Promise.allSettled([callerRoom.disconnect(), responderRoom.disconnect()]);
    },
  };
};
