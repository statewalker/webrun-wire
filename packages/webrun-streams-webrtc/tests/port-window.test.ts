import { describe, expect, it } from "vitest";

// Per-port windows on WebRTC's native ports (statewalker/webrun-wire#153): a
// mux given `window` opens each port's data channel with the windowed
// `protocol`; a serving mux with `window` sees it and says hello, and one
// without (an older peer) never does, so the port runs as before.
// Browser-only, like the rest of this package's WebRTC tests.
const isBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  const { deserialize, serialize } = await import("@statewalker/webrun-msgpack");
  const { connect, overPorts, serve } = await import("@statewalker/webrun-rpc");
  const { describeDuplexAdapter, describePortWindow } = await import(
    "@statewalker/webrun-streams-conformance"
  );
  const { connectedPeers } = await import("./make-webrtc-pair.js");
  const { DEFAULT_PORT_MAX_MESSAGE_SIZE, WINDOW_CHANNEL_PROTOCOL, webrtcPortMux } = await import(
    "../src/port-mux.js"
  );
  type MakePair = import("@statewalker/webrun-streams-conformance").MakePair;
  const codec = { encode: serialize, decode: deserialize };

  describePortWindow("webrtcPortMux", async (portCodec, windows) => {
    const { clientPc, serverPc } = await connectedPeers();
    const opener = await webrtcPortMux({ pc: clientPc, codec: portCodec, window: windows.opener });
    let serving: Awaited<ReturnType<typeof webrtcPortMux>> | undefined;
    return {
      opener,
      async serve(onPort) {
        serving = await webrtcPortMux({
          pc: serverPc,
          codec: portCodec,
          onPort,
          window: windows.server,
        });
        return serving;
      },
      async dispose() {
        await serving?.close();
        clientPc.close();
        serverPc.close();
      },
    };
  });

  describe("webrtcPortMux: the windowed channel", () => {
    it("a port of a mux with a window opens its data channel with the windowed protocol", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      const protocols: string[] = [];
      serverPc.addEventListener("datachannel", (e) => protocols.push(e.channel.protocol));
      const plain = await webrtcPortMux({ pc: clientPc, codec });
      const windowed = await webrtcPortMux({ pc: clientPc, codec, window: 1024 * 1024 });
      await plain.openPort();
      await windowed.openPort();
      await expect.poll(() => protocols.length).toBe(2);
      expect(protocols).toEqual(["", WINDOW_CHANNEL_PROTOCOL]);
      clientPc.close();
      serverPc.close();
    });
  });

  const WINDOW = 1024 * 1024;

  /**
   * The port stack over windowed native ports: chunks are pipelined, up to the
   * window in flight, and L6 holds a producer to the window (plus the chunk
   * queued in its port and the one in the consumer's hands).
   */
  const makeWindowedPair: MakePair = async (tuning) => {
    const { clientPc, serverPc } = await connectedPeers();
    const maxMessageSize = Math.min(
      tuning?.maxMessageSize ?? DEFAULT_PORT_MAX_MESSAGE_SIZE,
      DEFAULT_PORT_MAX_MESSAGE_SIZE,
    );
    return {
      runAheadBytes: WINDOW + 2 * maxMessageSize,
      async connect() {
        return connect({
          mux: overPorts(() =>
            webrtcPortMux({ pc: clientPc, codec, maxMessageSize, window: WINDOW }),
          ),
        });
      },
      async serve(handler) {
        return serve(
          {
            mux: overPorts((onPort) =>
              webrtcPortMux({ pc: serverPc, codec, onPort, maxMessageSize, window: WINDOW }),
            ),
          },
          handler,
        );
      },
      async close() {
        clientPc.close();
        serverPc.close();
      },
    };
  };

  describeDuplexAdapter("webrun-streams-webrtc, native ports with a window", makeWindowedPair);
} else {
  describe.skip("webrtcPortMux windows (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
