import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { connect, serve } from "../src/connect-serve.js";

/**
 * Two `RTCPeerConnection`s negotiated against each other inside the page.
 *
 * WebRTC normally needs a signalling channel to carry the offer, the answer
 * and the ICE candidates between peers. Here both peers live in the same
 * JavaScript realm, so "signalling" is a direct method call: the offer goes
 * straight into the other connection's `setRemoteDescription`, and each
 * candidate straight into the other's `addIceCandidate`. No server, no
 * network, nothing to configure.
 *
 * `iceServers` is deliberately empty. A default STUN server would make this
 * suite depend on outbound UDP to a third party; two connections in one page
 * pair up on host candidates alone, so asking for a reflexive address buys
 * nothing and fails closed when the machine is offline.
 */

/** How long to wait for the two connections to pair up before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

function waitConnected(pc: RTCPeerConnection, label: string): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `webrun-streams-webrtc: ${label} stuck in "${pc.connectionState}" after ` +
            `${CONNECT_TIMEOUT_MS}ms (ICE state "${pc.iceConnectionState}")`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);

    const onChange = (): void => {
      if (pc.connectionState === "connected") {
        cleanup();
        resolve();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new Error(`webrun-streams-webrtc: ${label} became "${pc.connectionState}"`));
      }
    };

    function cleanup(): void {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onChange);
    }

    pc.addEventListener("connectionstatechange", onChange);
  });
}

/**
 * `tuning` is accepted and ignored: this adapter does not use `emulateMux`.
 * It opens one `RTCDataChannel` per call and lets SCTP do the flow control,
 * so there is no advertised credit window to shrink. L6 therefore degrades to
 * an integrity check here — it proves the `Duplex` seam still holds under a
 * body many times any single frame, not that credit stalls and replenishes.
 * That distinction is stated in the conformance README.
 */
export const makeWebRtcPair: MakePair = async () => {
  const clientPc = new RTCPeerConnection({ iceServers: [] });
  const serverPc = new RTCPeerConnection({ iceServers: [] });

  // Trickle ICE, both directions. Candidates that arrive after the remote
  // description is set are applied immediately; the null candidate marking
  // end-of-gathering is skipped.
  clientPc.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) void serverPc.addIceCandidate(ev.candidate).catch(() => {});
  });
  serverPc.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) void clientPc.addIceCandidate(ev.candidate).catch(() => {});
  });

  // An offer only carries an `application` m-line if the connection already
  // has a data channel, and without that m-line SCTP is never negotiated and
  // every later `createDataChannel` stays stuck in "connecting". This channel
  // exists solely to shape the SDP and is closed once the peers are up.
  //
  // It is opened before `serve()` registers its `datachannel` listener, so the
  // handler never sees it.
  const bootstrap = clientPc.createDataChannel("webrun/bootstrap");

  const offer = await clientPc.createOffer();
  await clientPc.setLocalDescription(offer);
  await serverPc.setRemoteDescription(offer);

  const answer = await serverPc.createAnswer();
  await serverPc.setLocalDescription(answer);
  await clientPc.setRemoteDescription(answer);

  try {
    await Promise.all([waitConnected(clientPc, "caller"), waitConnected(serverPc, "responder")]);
  } catch (err) {
    clientPc.close();
    serverPc.close();
    throw err;
  }

  bootstrap.close();

  return {
    async connect() {
      return connect({ pc: clientPc });
    },
    async serve(handler) {
      return serve({ pc: serverPc }, handler);
    },
    async close() {
      clientPc.close();
      serverPc.close();
    },
  };
};
