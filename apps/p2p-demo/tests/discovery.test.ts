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

    const ca = discoveryClient(a, addr, "g1");
    const cb = discoveryClient(b, addr, "g1");

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

    await discoveryClient(a, addr, "g1").announce(ann(a, "alpha"));
    const cb = discoveryClient(b, addr, "g1");
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

  it("keeps different groups isolated, sharing only within a group", async () => {
    const relay = await mk(true);
    const a = await mk(false);
    const b = await mk(false);
    const c = await mk(false);
    const stop = await serveDiscovery(relay);
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    // a and b are in "alpha", c is alone in "beta".
    await discoveryClient(a, addr, "alpha").announce(ann(a, "alpha-svc"));
    const seenByBInAlpha = await discoveryClient(b, addr, "alpha").announce(ann(b, "beta-svc"));
    const seenByCInBeta = await discoveryClient(c, addr, "beta").announce(ann(c, "gamma-svc"));

    expect(seenByBInAlpha.map((x) => x.peerId)).toContain(a.peerId.toString());
    expect(seenByCInBeta.map((x) => x.peerId)).not.toContain(a.peerId.toString());
    expect(seenByCInBeta.map((x) => x.peerId)).not.toContain(b.peerId.toString());
    expect(seenByCInBeta).toHaveLength(0);

    await stop();
    await Promise.allSettled([relay.stop(), a.stop(), b.stop(), c.stop()]);
  });

  it("does not leak empty group entries after peers expire", async () => {
    const relay = await mk(true);
    const stop = await serveDiscovery(relay, { ttlMs: 150, sweepMs: 25 });
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const peers = await Promise.all(Array.from({ length: 5 }, () => mk(false)));
    await Promise.all(
      peers.map((p, i) => discoveryClient(p, addr, `group-${i}`).announce(ann(p, `svc-${i}`))),
    );

    expect(stop.groupCount).toBe(5);

    await new Promise((r) => setTimeout(r, 400));
    expect(stop.groupCount).toBe(0);

    await stop();
    await Promise.allSettled([relay.stop(), ...peers.map((p) => p.stop())]);
  });

  it("includes the relay's own entry in every catalogue when selfServices is set", async () => {
    const relay = await mk(true);
    const a = await mk(false);
    const hubServices = [{ id: "hub", kind: "presence-hub" as const, title: "Hub" }];
    const stop = await serveDiscovery(relay, { selfServices: hubServices });
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const seen = await discoveryClient(a, addr, "g1").announce(ann(a, "alpha"));
    const hubEntry = seen.find((x) => x.peerId === relay.peerId.toString());
    expect(hubEntry).toBeDefined();
    expect(hubEntry?.services).toEqual(hubServices);

    await stop();
    await Promise.allSettled([relay.stop(), a.stop()]);
  });

  it("omits the relay's own entry when selfServices is unset", async () => {
    const relay = await mk(true);
    const a = await mk(false);
    const stop = await serveDiscovery(relay);
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const seen = await discoveryClient(a, addr, "g1").announce(ann(a, "alpha"));
    expect(seen.map((x) => x.peerId)).not.toContain(relay.peerId.toString());

    await stop();
    await Promise.allSettled([relay.stop(), a.stop()]);
  });

  it("still returns groupCount to 0 after peers expire when selfServices is configured", async () => {
    const relay = await mk(true);
    const stop = await serveDiscovery(relay, {
      ttlMs: 150,
      sweepMs: 25,
      selfServices: [{ id: "hub", kind: "presence-hub", title: "Hub" }],
    });
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const peers = await Promise.all(Array.from({ length: 5 }, () => mk(false)));
    await Promise.all(
      peers.map((p, i) => discoveryClient(p, addr, `group-${i}`).announce(ann(p, `svc-${i}`))),
    );

    // The relay's synthetic self entry must not be written into GroupState
    // (only injected at response time) — otherwise no group would ever go
    // empty and groupCount would never return to 0.
    expect(stop.groupCount).toBe(5);

    await new Promise((r) => setTimeout(r, 400));
    expect(stop.groupCount).toBe(0);

    await stop();
    await Promise.allSettled([relay.stop(), ...peers.map((p) => p.stop())]);
  });
});
