import {
  type Connect,
  type Duplex,
  type EmulateMuxOptions,
  emulateMux,
  type Serve,
} from "@statewalker/webrun-streams";
import type { Room } from "livekit-client";
import { byteChannelFromLiveKit } from "./byte-channel.js";

export interface LiveKitParams {
  /** Already-connected LiveKit `Room`. */
  room: Room;
  /** Identity of the remote participant the call addresses. */
  peerIdentity: string;
  /**
   * Flow-control tuning forwarded to `emulateMux` — `mtu` and
   * `maxStreamBuffer`, which is the credit this side advertises. `side` here
   * wins over `mux.side`. Defaults are `emulateMux`'s own; the conformance
   * suite's L6 uses this to run at a window small enough that a sender
   * genuinely stalls.
   */
  mux?: EmulateMuxOptions;
}

export const connect: Connect<LiveKitParams> = async ({ room, peerIdentity, mux: muxOpts }) => {
  const channel = byteChannelFromLiveKit(room, peerIdentity);
  const mux = emulateMux(channel, { ...muxOpts, side: "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

export const serve: Serve<LiveKitParams> = async (
  { room, peerIdentity, mux: muxOpts },
  handler: Duplex,
) => {
  const channel = byteChannelFromLiveKit(room, peerIdentity);
  const mux = emulateMux(channel, { ...muxOpts, side: "responder" });
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
