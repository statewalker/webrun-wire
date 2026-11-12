import { describe, expect, it } from "vitest";

// Native MessagePorts over WebRTC: a data channel per port. Browser-only, like
// the rest of this package's WebRTC tests.
const isBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  const { deserialize, serialize } = await import("@statewalker/webrun-msgpack");
  const { connect, overPorts, serve } = await import("@statewalker/webrun-rpc");
  const { collectBytes } = await import("@statewalker/webrun-streams");
  const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
  const { connectedPeers } = await import("./make-webrtc-pair.js");
  const { DEFAULT_PORT_MAX_FRAME_BYTES, webrtcPortMux } = await import("../src/port-mux.js");
  type MakePair = import("@statewalker/webrun-streams-conformance").MakePair;
  const codec = { encode: serialize, decode: deserialize };

  /**
   * The port stack over WebRTC with NATIVE ports: every port is its own data
   * channel. L6: the port stack keeps a producer within one chunk of a stalled
   * consumer, where this package's `connect` / `serve` allow its 4 MiB window.
   */
  const makeNativePortPair: MakePair = async (tuning) => {
    const { clientPc, serverPc } = await connectedPeers();
    const fit = (n?: number) => (n === undefined ? undefined : Math.min(n, 16 * 1024 - 256));
    return {
      runAheadBytes: 4096,
      async connect() {
        return connect({
          mux: overPorts(() =>
            webrtcPortMux({ pc: clientPc, codec, maxMessageSize: fit(tuning?.maxMessageSize) }),
          ),
        });
      },
      async serve(handler) {
        return serve(
          {
            mux: overPorts((onPort) =>
              webrtcPortMux({
                pc: serverPc,
                codec,
                onPort,
                maxMessageSize: fit(tuning?.maxMessageSize),
              }),
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

  describeDuplexAdapter(
    "webrun-streams-webrtc, native ports (a data channel per port)",
    makeNativePortPair,
  );

  describe("webrtcPortMux", () => {
    it("each port is its own data channel, labelled; ports from other users of the connection are left alone", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      const labels: string[] = [];
      serverPc.addEventListener("datachannel", (e) => labels.push(e.channel.label));
      const accepted: unknown[] = [];
      await webrtcPortMux({
        pc: serverPc,
        codec,
        onPort: (port) => {
          accepted.push(port);
          port.addEventListener("message", (e) => port.postMessage({ echo: e.data }));
          return true;
        },
      });
      const mux = await webrtcPortMux({ pc: clientPc, codec });
      const p1 = await mux.openPort();
      const p2 = await mux.openPort();
      const other = clientPc.createDataChannel("someone-else");
      const got = new Promise((r) => p2.addEventListener("message", (e) => r(e.data)));
      p2.postMessage({ hi: 2 });
      expect(await got).toEqual({ echo: { hi: 2 } });
      await expect.poll(() => labels.length).toBe(3);
      expect(accepted.length).toBe(2);
      expect(labels.filter((l) => l.startsWith("webrun-port/")).length).toBe(2);
      other.close();
      void p1;
      clientPc.close();
      serverPc.close();
    });

    it("a port's close signal aborts when the peer connection closes, and a call in flight fails", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      await serve(
        { mux: overPorts((onPort) => webrtcPortMux({ pc: serverPc, codec, onPort })) },
        async function* (input) {
          for await (const _ of input);
          yield new Uint8Array([1]);
          await new Promise(() => {});
        },
      );
      const { call, close } = await connect({
        mux: overPorts(() => webrtcPortMux({ pc: clientPc, codec })),
      });
      const it = call([])[Symbol.asyncIterator]();
      await it.next();
      const rest = it.next();
      serverPc.close();
      await expect(rest).rejects.toBeDefined();
      await close();
      clientPc.close();
    });

    it("a refused port is closed: the opener's signal aborts and a call on it fails", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      await webrtcPortMux({ pc: serverPc, codec, onPort: () => false });
      const mux = await webrtcPortMux({ pc: clientPc, codec });
      const port = await mux.openPort();
      await expect.poll(() => port.closeSignal.aborted, { timeout: 5000 }).toBe(true);
      const { call, close } = await connect({
        mux: overPorts(() => webrtcPortMux({ pc: clientPc, codec })),
      });
      const failure = await Promise.race([
        collectBytes(call([new Uint8Array([1])])).catch((e) => e as Error),
        new Promise((r) => setTimeout(() => r("hung"), 4000)),
      ]);
      expect(failure).toBeInstanceOf(Error);
      await close();
      clientPc.close();
      serverPc.close();
    });

    it("a frame past the data channel's cross-browser limit fails the port loudly", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      await webrtcPortMux({ pc: serverPc, codec, onPort: () => true });
      const mux = await webrtcPortMux({ pc: clientPc, codec });
      const port = await mux.openPort();
      expect(() => port.postMessage(new Uint8Array(DEFAULT_PORT_MAX_FRAME_BYTES + 1))).toThrow(
        RangeError,
      );
      expect(port.closeSignal.aborted).toBe(true);
      clientPc.close();
      serverPc.close();
    });

    it("a connection that fails (ICE) aborts its ports, though their channels have not closed yet", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      await webrtcPortMux({ pc: serverPc, codec, onPort: () => true });
      const mux = await webrtcPortMux({ pc: clientPc, codec });
      const port = await mux.openPort();
      Object.defineProperty(clientPc, "connectionState", {
        get: () => "failed",
        configurable: true,
      });
      clientPc.dispatchEvent(new Event("connectionstatechange"));
      expect(port.closeSignal.aborted).toBe(true);
      clientPc.close();
      serverPc.close();
    });

    it("messages that arrive before the port's first listener are kept for it", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      await webrtcPortMux({
        pc: serverPc,
        codec,
        onPort: (port) => {
          port.postMessage({ greeting: "sent before anyone listened" });
          return true;
        },
      });
      const mux = await webrtcPortMux({ pc: clientPc, codec });
      const port = await mux.openPort();
      await new Promise((r) => setTimeout(r, 300)); // the greeting has arrived by now
      const got = await new Promise((r) => port.addEventListener("message", (e) => r(e.data)));
      expect(got).toEqual({ greeting: "sent before anyone listened" });
      clientPc.close();
      serverPc.close();
    });

    it("close() stops accepting and closes the ports it opened", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      const serving = await webrtcPortMux({ pc: serverPc, codec, onPort: () => true });
      const mux = await webrtcPortMux({ pc: clientPc, codec });
      const p = await mux.openPort();
      await mux.close();
      expect(p.closeSignal.aborted).toBe(true);
      await expect(mux.openPort()).rejects.toThrow();
      await serving.close();
      clientPc.close();
      serverPc.close();
    });
  });
} else {
  describe.skip("webrtcPortMux (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
