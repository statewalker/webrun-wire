import { describe, expect, it } from "vitest";

// The spec's gate on Plan C2: measure what a raw PeerJS DataConnection does with
// a message past the data channel's limit, before trusting any maxMessageSize.
const isBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  const { Peer } = await import("peerjs");
  const { inject } = await import("vitest");
  describe("PeerJS raw DataConnection: message sizes (measurement)", () => {
    it("reports which sizes arrive whole, split, or not at all", async () => {
      const port = inject("peerServerPort");
      const suffix = Math.random().toString(36).slice(2, 10);
      const options = { host: "127.0.0.1", port, path: "/webrun", secure: false, debug: 0 };
      const a = new Peer(`ceil-a-${suffix}`, options);
      const b = new Peer(`ceil-b-${suffix}`, options);
      await Promise.all([a, b].map((p) => new Promise((r) => p.on("open", r))));
      const inbound = new Promise<import("peerjs").DataConnection>((r) => b.on("connection", r));
      const conn = a.connect(`ceil-b-${suffix}`, { serialization: "raw", reliable: true });
      await new Promise((r) => conn.on("open", r));
      const peerConn = await inbound;
      await new Promise((r) => (peerConn.open ? r(undefined) : peerConn.on("open", r)));
      const errors: string[] = [];
      conn.on("error", (e) => errors.push(String((e as Error).message ?? e)));
      const report: string[] = [];
      for (const size of [16 * 1024, 64 * 1024, 256 * 1024 - 1, 256 * 1024 + 1, 1024 * 1024]) {
        const got: number[] = [];
        const onData = (d: unknown) =>
          got.push((d as ArrayBuffer).byteLength ?? (d as Uint8Array).length);
        peerConn.on("data", onData);
        let thrown = "";
        try {
          conn.send(new Uint8Array(size));
        } catch (e) {
          thrown = String(e);
        }
        await new Promise((r) => setTimeout(r, 1500));
        peerConn.off("data", onData);
        const line = `size=${size} received=${JSON.stringify(got)} thrown=${thrown || "-"} errors=${errors.splice(0).join("|") || "-"} open=${conn.open}`;
        report.push(line);
        console.log(line);
        if (!conn.open) break;
      }
      a.destroy();
      b.destroy();
      // The cross-browser default rests on 16 KiB arriving whole; the rest is a measurement.
      expect(report[0]).toMatch(/^size=16384 received=\[16384\] thrown=- errors=- open=true$/);
    }, 60_000);
  });
} else {
  describe.skip("PeerJS message ceiling (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
