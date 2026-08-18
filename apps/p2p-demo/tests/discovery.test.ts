import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { connect } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { describe, expect, it } from "vitest";
import type { ServiceAnnouncement } from "../lib/announcement.js";
import { DISCOVERY_PROTOCOL, discoveryClient, serveDiscovery } from "../lib/discovery.js";

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

  it("still returns groupCount to 0 after peers expire when selfServices is configured, and a fresh announce afterward sees no resurrected peers", async () => {
    const relay = await mk(true);
    const hubServices = [{ id: "hub", kind: "presence-hub" as const, title: "Hub" }];
    const stop = await serveDiscovery(relay, {
      ttlMs: 150,
      sweepMs: 25,
      selfServices: hubServices,
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

    // A test that only checks groupCount returning to 0 would also pass
    // against a buggy variant that persists the self entry into GroupState
    // but happens not to be re-touched during the wait above — it decays
    // alongside the real peer and the count still lands on 0 for the wrong
    // reason. Close that gap: announce once more into one of the
    // now-deleted groups (re-using peers[0], the peer that originally
    // announced into "group-0" and then went stale) and inspect what
    // comes back.
    const [p0] = peers;
    if (p0 == null) throw new Error("expected at least one peer");
    const seenAfterExpiry = await discoveryClient(p0, addr, "group-0").announce(
      ann(p0, "svc-fresh"),
    );

    // Only the synthetic self entry should appear — not the announcer
    // itself (excluded as the proven announcer), and nothing resurrected
    // from before eviction (this same peer's own prior entry in this group
    // included, since the group was fully deleted and rebuilt from empty).
    expect(seenAfterExpiry.map((x) => x.peerId)).toEqual([relay.peerId.toString()]);
    expect(seenAfterExpiry[0]?.services).toEqual(hubServices);
    // Exactly the one group this announce just recreated — the other four
    // stay gone, proving groupCount tracks live groups, not a hub-entry
    // side effect.
    expect(stop.groupCount).toBe(1);

    await stop();
    await Promise.allSettled([relay.stop(), ...peers.map((p) => p.stop())]);
  });

  it("evicts a group whose sole member leaves, even with selfServices set, while a busier group stays alive", async () => {
    const relay = await mk(true);
    const hubServices = [{ id: "hub", kind: "presence-hub" as const, title: "Hub" }];
    const stop = await serveDiscovery(relay, { selfServices: hubServices });
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const busy = await mk(false);
    const quitter = await mk(false);

    // "busy" receives several real announces spanning the whole test, so it
    // is legitimately alive throughout — a control that a test which only
    // checks "the count went down" can't tell apart from an accidental
    // eviction.
    const busyClient = discoveryClient(busy, addr, "busy");
    await busyClient.announce(ann(busy, "busy-1"));

    // "quitter" is the group under test: its one member joins, then leaves
    // explicitly — `applyLeave` (group-state.ts) removes it from GroupState
    // immediately, no TTL wait required.
    const quitterClient = discoveryClient(quitter, addr, "quitter");
    await quitterClient.announce(ann(quitter, "quitter-svc"));
    expect(stop.groupCount).toBe(2);

    await quitterClient.announce({ ...ann(quitter, "quitter-svc"), leave: true });

    // More real traffic on "busy" while "quitter" sits empty, proving the
    // two groups are tracked independently rather than the count moving for
    // an unrelated reason.
    await busyClient.announce(ann(busy, "busy-2"));

    // If the relay's synthetic self entry were written into GroupState
    // (instead of synthesized fresh per response, per the doc comment on
    // serveDiscovery), "quitter"'s state would never reach size 0 once its
    // only real member leaves — the self entry would keep it permanently
    // non-empty and `groups.delete("quitter")` would never fire. Only
    // "busy" should remain.
    expect(stop.groupCount).toBe(1);

    await stop();
    await Promise.allSettled([relay.stop(), busy.stop(), quitter.stop()]);
  });

  // The one line every other test in this file is blind to: every other test
  // announces with a truthful `peerId`, so deleting `peerId: proven` from
  // `serveDiscovery` (discovery.ts) keeps them all green — the claimed and the
  // proven string are the same value, and the self-filter, `applyAnnouncement`
  // and `applyLeave` all key on it either way.
  //
  // Verified to fail before the fix: replacing `peerId: proven` with
  // `peerId: incoming.peerId` fails this with
  // `expected [ '12D3Koo…victim', 'not-a-peer-id-at-all' ] to strictly equal
  // [ '12D3Koo…liar' ]`.
  it("catalogues the announcer's proven peer id, never the one the payload claims", async () => {
    const relay = await mk(true);
    const liar = await mk(false);
    const victim = await mk(false);
    const observer = await mk(false);
    const stop = await serveDiscovery(relay);
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    const liarClient = discoveryClient(liar, addr, "g1");

    // Forgery 1: claim to be another real peer in the same group.
    await liarClient.announce({
      v: 1,
      peerId: victim.peerId.toString(),
      services: [{ kind: "http", id: "spoofed", title: "Spoofed", path: "/spoofed" }],
      ts: Date.now(),
    });
    // Forgery 2: a peer id that is not a peer id at all.
    await liarClient.announce({
      v: 1,
      peerId: "not-a-peer-id-at-all",
      services: [{ kind: "http", id: "garbage", title: "Garbage", path: "/garbage" }],
      ts: Date.now(),
    });

    const seenByObserver = await discoveryClient(observer, addr, "g1").announce(
      ann(observer, "obs"),
    );

    // Both forgeries collapsed onto the one identity Noise proved for the
    // connection they arrived on, so the group holds exactly one other peer.
    expect(seenByObserver.map((x) => x.peerId)).toStrictEqual([liar.peerId.toString()]);
    // And the impersonated peer — which never announced at all — is not in the
    // catalogue the next peer receives.
    expect(seenByObserver.map((x) => x.peerId)).not.toContain(victim.peerId.toString());

    // The victim announcing for real is a separate entry, not a takeover of
    // the one the liar planted.
    const seenByVictim = await discoveryClient(victim, addr, "g1").announce(ann(victim, "real"));
    expect(seenByVictim.map((x) => x.peerId).sort()).toStrictEqual(
      [liar.peerId.toString(), observer.peerId.toString()].sort(),
    );

    await stop();
    await Promise.allSettled([relay.stop(), liar.stop(), victim.stop(), observer.stop()]);
  });

  // `collect()` has to buffer a whole message before it can be decoded, so
  // without a cap a peer can make the shared relay hold as much memory as it
  // cares to stream at it.
  //
  // Verified to fail before the fix: with the cap removed from `collect`, the
  // relay swallows all 2.4 MiB and answers normally, and this fails with
  // `promise resolved instead of rejecting`.
  it("refuses a request larger than the cap, and keeps serving afterwards", async () => {
    const relay = await mk(true);
    const flooder = await mk(false);
    const honest = await mk(false);
    const stop = await serveDiscovery(relay);
    const addr = relay.getMultiaddrs()[0];
    if (addr == null) throw new Error("relay has no listen address");

    // Straight onto the discovery protocol rather than through
    // `discoveryClient`, because the point is a peer that ignores the
    // envelope's shape entirely and just streams.
    const { call, close } = await connect({
      node: flooder,
      peer: addr,
      protocol: DISCOVERY_PROTOCOL,
    });
    const flood = (async function* () {
      for (let i = 0; i < 24; i++) yield new Uint8Array(100 * 1024).fill(7);
    })();
    await expect(
      (async () => {
        for await (const _chunk of call(flood)) {
          // the relay is expected to error, not answer
        }
      })(),
    ).rejects.toThrow(/exceeds 1048576 bytes/);
    await close();

    // The flood created no group, and the relay still answers a real peer.
    const seen = await discoveryClient(honest, addr, "g1").announce(ann(honest, "svc"));
    expect(seen).toStrictEqual([]);
    expect(stop.groupCount).toBe(1);

    await stop();
    await Promise.allSettled([relay.stop(), flooder.stop(), honest.stop()]);
  });
});
