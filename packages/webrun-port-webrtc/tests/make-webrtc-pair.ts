import type { MakePair } from "@statewalker/webrun-port-conformance";
import { createDataChannelPortAsync } from "../src/index.js";

/**
 * In-process pair of WebRTC peers connected via direct SDP/ICE message
 * forwarding. Uses globalThis.RTCPeerConnection when available (browser); else
 * loads @roamhq/wrtc (Node-side polyfill).
 */

interface PeerConstructorBundle {
  RTCPeerConnection: typeof RTCPeerConnection;
}

async function loadWebRtc(): Promise<PeerConstructorBundle> {
  const g = globalThis as typeof globalThis & {
    RTCPeerConnection?: typeof RTCPeerConnection;
  };
  if (typeof g.RTCPeerConnection === "function") {
    return { RTCPeerConnection: g.RTCPeerConnection };
  }
  // Node-side: try the polyfill. If it's missing we surface a clear error.
  try {
    const mod = (await import("@roamhq/wrtc")) as {
      default?: { RTCPeerConnection: typeof RTCPeerConnection };
      RTCPeerConnection?: typeof RTCPeerConnection;
    };
    const ctor = mod.RTCPeerConnection ?? mod.default?.RTCPeerConnection;
    if (!ctor) throw new Error("@roamhq/wrtc did not export RTCPeerConnection");
    return { RTCPeerConnection: ctor };
  } catch (err) {
    throw new Error(
      `webrun-port-webrtc tests require either a browser RTCPeerConnection or @roamhq/wrtc; got ${(err as Error).message}`,
    );
  }
}

export const makeWebRtcPair: MakePair = async () => {
  const { RTCPeerConnection } = await loadWebRtc();

  const pcA = new RTCPeerConnection();
  const pcB = new RTCPeerConnection();

  // Trickle ICE: forward each side's candidates to the other.
  pcA.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) void pcB.addIceCandidate(ev.candidate);
  });
  pcB.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) void pcA.addIceCandidate(ev.candidate);
  });

  const channelA = pcA.createDataChannel("conformance");

  const channelBPromise = new Promise<RTCDataChannel>((resolve) => {
    pcB.addEventListener("datachannel", (ev) => {
      resolve(ev.channel);
    });
  });

  // SDP exchange.
  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await pcB.setRemoteDescription(offer);
  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(answer);

  const channelB = await channelBPromise;
  const [a, b] = await Promise.all([
    createDataChannelPortAsync(channelA),
    createDataChannelPortAsync(channelB),
  ]);

  return {
    a,
    b,
    async close() {
      try {
        a.close();
      } catch {}
      try {
        b.close();
      } catch {}
      try {
        pcA.close();
      } catch {}
      try {
        pcB.close();
      } catch {}
    },
  };
};
