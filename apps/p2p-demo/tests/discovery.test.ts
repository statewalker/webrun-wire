import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { describe, expect, it } from "vitest";
import type { ServiceAnnouncement } from "../lib/announcement.js";
import { discoveryClient, serveDiscovery } from "../lib/discovery.js";

const mk = (listen: boolean) =>
  createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } : {},
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });

const ann = (node: Libp2p, id: string): ServiceAnnouncement => ({
  v: 1,
  peerId: node.peerId.toString(),
  services: [{ kind: "http", id, title: id, path: `/${id}` }],
  ts: Date.now(),
});

describe("relay-mediated discovery", () => {
  it("gives each peer the other's catalogue", async () => {
    const relay = await mk(true);
    const a = await mk(false);
    const b = await mk(false);
    const stop = await serveDiscovery(relay);
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const ca = discoveryClient(a, addr);
    const cb = discoveryClient(b, addr);

    await ca.announce(ann(a, "alpha"));
    const seenByB = await cb.announce(ann(b, "beta"));
    const seenByA = await ca.announce(ann(a, "alpha"));

    expect(seenByB.map((x) => x.peerId)).toContain(a.peerId.toString());
    expect(seenByA.map((x) => x.peerId)).toContain(b.peerId.toString());

    await stop();
    await Promise.allSettled([relay.stop(), a.stop(), b.stop()]);
  });

  it("drops a peer that stops announcing, after the TTL", async () => {
    const relay = await mk(true);
    const a = await mk(false);
    const b = await mk(false);
    const stop = await serveDiscovery(relay, { ttlMs: 150, sweepMs: 25 });
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    await discoveryClient(a, addr).announce(ann(a, "alpha"));
    const cb = discoveryClient(b, addr);
    expect((await cb.announce(ann(b, "beta"))).map((x) => x.peerId)).toContain(
      a.peerId.toString(),
    );

    await new Promise((r) => setTimeout(r, 400));
    expect((await cb.announce(ann(b, "beta"))).map((x) => x.peerId)).not.toContain(
      a.peerId.toString(),
    );

    await stop();
    await Promise.allSettled([relay.stop(), a.stop(), b.stop()]);
  });
});
