import { type Connect, type Duplex, emulateMux, type Serve } from "@statewalker/webrun-streams";
import type { Room } from "livekit-client";
import { byteChannelFromLiveKit } from "./byte-channel.js";

export interface LiveKitParams {
  /** Already-connected LiveKit `Room`. */
  room: Room;
  /** Identity of the remote participant the call addresses. */
  peerIdentity: string;
}

export const connect: Connect<LiveKitParams> = async ({ room, peerIdentity }) => {
  const channel = byteChannelFromLiveKit(room, peerIdentity);
  const mux = emulateMux(channel, { side: "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

export const serve: Serve<LiveKitParams> = async ({ room, peerIdentity }, handler: Duplex) => {
  const channel = byteChannelFromLiveKit(room, peerIdentity);
  const mux = emulateMux(channel, { side: "responder" });
  const off = mux.serve(handler);
  void channel.closed.then(() => mux.close());
  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await off();
    await mux.close();
  };
};
