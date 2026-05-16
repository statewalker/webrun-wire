import { type Connect, type Duplex, emulateMux, type Serve } from "@statewalker/webrun-streams";
import { byteChannelFromMessagePort } from "./byte-channel.js";

export interface PortParams {
  port: MessagePort;
  /**
   * Mux side for stream-id allocation. Initiator uses even ids; responder
   * uses odd. Defaults to "initiator" on `connect` and "responder" on `serve`.
   */
  side?: "initiator" | "responder";
}

export const connect: Connect<PortParams> = async ({ port, side }) => {
  const channel = byteChannelFromMessagePort(port);
  const mux = emulateMux(channel, { side: side ?? "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

export const serve: Serve<PortParams> = async ({ port, side }, handler: Duplex) => {
  const channel = byteChannelFromMessagePort(port);
  const mux = emulateMux(channel, { side: side ?? "responder" });
  const off = mux.serve(handler);
  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await off();
    await mux.close();
  };
};
