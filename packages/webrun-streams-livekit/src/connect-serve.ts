import {
  type Connect,
  type Duplex,
  type EmulateMuxOptions,
  emulateMux,
  type Serve,
} from "@statewalker/webrun-streams";
import type { Room } from "livekit-client";
import { byteChannelFromLiveKit } from "./byte-channel.js";

/**
 * Default `mtu` for this transport.
 *
 * `emulateMux` defaults to 64 KiB, which LiveKit cannot carry: a reliable data
 * packet is capped around 15 KiB, and anything larger is dropped rather than
 * fragmented. The symptom is not an error — a 1 MiB body simply arrives as
 * zero bytes and a 10 MiB body hangs — so the ceiling has to be applied here,
 * where the transport is known, rather than left to every caller.
 *
 * 12 KiB leaves room for the mux frame header (`[varint streamId][1-byte
 * type]`) inside that budget. An explicit `mux.mtu` still wins, so a caller who
 * knows their deployment allows more can raise it.
 */
const LIVEKIT_SAFE_MTU = 12 * 1024;

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
  const mux = emulateMux(channel, {
    mtu: LIVEKIT_SAFE_MTU,
    ...muxOpts,
    side: "initiator",
  });
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
  const mux = emulateMux(channel, {
    mtu: LIVEKIT_SAFE_MTU,
    ...muxOpts,
    side: "responder",
  });
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
