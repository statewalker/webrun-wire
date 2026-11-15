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

  describePortWindow(
    "webrtcPortMux",
    async (portCodec, windows) => {
      const { clientPc, serverPc } = await connectedPeers();
      const opener = await webrtcPortMux({
        pc: clientPc,
        codec: portCodec,
        window: windows.opener,
      });
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
    },
    { maxFrameBytes: 16 * 1024 },
  );

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

  describe("webrtcPortMux: a bounded send-ahead (statewalker/webrun-wire#195)", () => {
    it("a peer announcing a 4 GiB window: the sender's data channel holds at most its low-water mark and a frame", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      let serverChannel: RTCDataChannel | undefined;
      serverPc.addEventListener("datachannel", (e) => {
        serverChannel = e.channel;
      });
      const { PORT_DRAIN_LOW_WATER } = await import("../src/port-mux.js");
      const { portFlow } = await import("@statewalker/webrun-streams");
      const body = new Uint8Array(15 * 1024).fill(3);
      const TOTAL = 8 * 1024 * 1024;
      let worst = 0;
      let posted = 0;
      await webrtcPortMux({
        pc: serverPc,
        codec,
        window: 1024 * 1024,
        onPort: (port) => {
          void (async () => {
            const flow = portFlow(port);
            // A producer that waits only on the port's queue, as the stream tier does.
            while (posted < TOTAL && !port.closeSignal.aborted) {
              port.postMessage(body);
              posted += body.byteLength;
              worst = Math.max(worst, serverChannel?.bufferedAmount ?? 0);
              if ((flow?.bufferedAmount() ?? 0) > 0) await flow?.ready();
            }
          })();
          return true;
        },
      });
      // The caller grants the most a hello can carry, and never consumes: no credit goes back.
      const opener = await webrtcPortMux({ pc: clientPc, codec, window: 0xffffffff });
      const port = await opener.openPort();
      port.addEventListener("message", () => new Promise<void>(() => {}));
      port.postMessage(new Uint8Array(1));
      // Bounded by the server's own 1 MiB window: the producer stops short of TOTAL.
      await expect.poll(() => posted, { timeout: 5_000 }).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(posted).toBeLessThanOrEqual(1024 * 1024 + 2 * body.byteLength);
      expect(worst).toBeLessThanOrEqual(PORT_DRAIN_LOW_WATER + 2 * body.byteLength);
      clientPc.close();
      serverPc.close();
    }, 30_000);
  });
} else {
  describe.skip("webrtcPortMux windows (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
