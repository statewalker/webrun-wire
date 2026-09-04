import {
  type Connect,
  type Duplex,
  type EmulateMuxOptions,
  emulateMux,
  type Serve,
} from "@statewalker/webrun-streams";
import { byteChannelFromMessagePort } from "./byte-channel.js";

export interface PortParams {
  port: MessagePort;
  /**
   * Mux side for stream-id allocation. Initiator uses even ids; responder
   * uses odd. Defaults to "initiator" on `connect` and "responder" on `serve`.
   */
  side?: "initiator" | "responder";
  /**
   * Flow-control tuning forwarded to `emulateMux` — `mtu` and
   * `maxStreamBuffer`, which is the credit this side advertises. `side` here
   * wins over `mux.side`. Defaults are `emulateMux`'s own; the conformance
   * suite's L6 uses this to run at a window small enough that a sender
   * genuinely stalls.
   */
  mux?: EmulateMuxOptions;
}

export const connect: Connect<PortParams> = async ({ port, side, mux: muxOpts }) => {
  const channel = byteChannelFromMessagePort(port);
  const mux = emulateMux(channel, { ...muxOpts, side: side ?? muxOpts?.side ?? "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

export const serve: Serve<PortParams> = async ({ port, side, mux: muxOpts }, handler: Duplex) => {
  const channel = byteChannelFromMessagePort(port);
  const mux = emulateMux(channel, { ...muxOpts, side: side ?? muxOpts?.side ?? "responder" });
  const off = mux.serve(handler);
  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await off();
    await mux.close();
  };
};
