import { afterEach, describe, expect, it } from "vitest";
import type { MessageListener, MessageTarget } from "../src/message-target.js";
import { multiplexPort } from "../src/multiplex-port.js";
import type { PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

/** Real MessagePorts: a MessagePort satisfies MessageTarget structurally. */
function newChannel() {
  const channel = new MessageChannel();
  rawPorts.push(channel.port1, channel.port2);
  return { a: channel.port1, b: channel.port2 };
}

/**
 * Poll `predicate` until it is true, or fail with `label`. A fixed number of
 * macrotask ticks is a race, not a synchronisation: it usually wins under a
 * light load and sometimes loses under a heavier one (the sibling suites in
 * this package measured an 8% failure rate on unmutated code with fixed tick
 * counts). Polling on the actual condition removes the race instead of
 * relocating it.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const muxes: PortMux[] = [];
function track<T extends PortMux>(mux: T): T {
  muxes.push(mux);
  return mux;
}

// A live MessagePort keeps the Node process alive, so both raw ports of every
// channel are tracked here and closed in afterEach, even the ones no mux ever
// held (a mux closes only its own underlying port on close()).
const rawPorts: MessagePort[] = [];

afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((mux) => mux.close()));
  for (const port of rawPorts.splice(0)) port.close();
});

/**
 * A bare-bones `MessageTarget` double for the two lifecycle checks that need
 * to observe the mux's *own* calls into the underlying port — no real
 * MessagePort exposes "was removeEventListener called with this exact
 * function" or "was close() invoked" to a test.
 */
function fakeTarget() {
  const added: MessageListener[] = [];
  const removed: MessageListener[] = [];
  let closeCalls = 0;
  const target: MessageTarget = {
    addEventListener: (_type, listener) => {
      added.push(listener);
    },
    removeEventListener: (_type, listener) => {
      removed.push(listener);
    },
    postMessage: () => {
      // No wire on the other end; nothing to deliver.
    },
    close: () => {
      closeCalls++;
    },
  };
  return {
    target,
    added,
    removed,
    closeCalls: () => closeCalls,
  };
}

describe("layer 1 lifecycle and limits", () => {
  it("retires ids on both the local and inbound close paths, so churn never exhausts maxPorts", async () => {
    // D19: "maxPorts bounds concurrency, not total opens." Deleting either
    // `open.delete(id)` — on the local-close path in `attach`'s
    // `requestClose`, or on the inbound-close path in `handleEnvelope` —
    // makes ids accumulate instead of retiring, so a mux with a small
    // `maxPorts` dies partway through a long open/close churn even though
    // concurrency never exceeds 1. Per-channel ordering keeps each side's
    // bookkeeping strictly sequential regardless of how fast the loop below
    // fires, so this is a true test of retirement, not of scheduling luck.
    const { a, b } = newChannel();
    const maxPorts = 4;
    let acceptedCount = 0;
    let lastAccepted: unknown;
    let lastDelivered: unknown;
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        maxPorts,
        onPort: (port, meta) => {
          acceptedCount++;
          lastAccepted = meta;
          port.addEventListener("message", (event) => {
            lastDelivered = event.data;
          });
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec, maxPorts }));

    const cycles = 5000;
    for (let i = 0; i < cycles; i++) {
      const port = client.openPort(i);
      port.postMessage(i);
      port.close?.();
    }

    await waitFor(() => acceptedCount >= cycles, `all ${cycles} cycles accepted`, 15000);

    // Floor: the last cycle's port carried a message and was individually
    // addressed, not just counted.
    expect(lastAccepted).toBe(cycles - 1);
    await waitFor(() => lastDelivered === cycles - 1, "the last cycle's message was delivered");
  });

  it("rejects an inbound OPEN once the responder's own maxPorts is reached", async () => {
    // This is the inbound half of `refuses to open beyond maxPorts` in
    // invariants.test.ts, which only ever exercises the outbound throw.
    // Forging the OPEN directly onto the wire is the only way to reach the
    // inbound rejection at all: a conforming client throws locally before
    // ever emitting a third OPEN.
    const { a, b } = newChannel();
    const acceptedIds: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        maxPorts: 2,
        onPort: (_port, meta) => {
          acceptedIds.push(meta);
        },
      }),
    );
    track(multiplexPort(a, { codec: structuredCodec, maxPorts: 2 }));

    a.postMessage({ type: "open", id: 0, meta: "one" });
    a.postMessage({ type: "open", id: 2, meta: "two" });
    await waitFor(() => acceptedIds.length >= 2, "both legitimate opens accepted");

    let maxPortsCloseSeenAtA = 0;
    a.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "close" && envelope.reason === "max-ports") maxPortsCloseSeenAtA++;
    });

    // A third OPEN, forged directly on the wire, past the ceiling of 2.
    a.postMessage({ type: "open", id: 99, meta: "three" });
    await waitFor(() => maxPortsCloseSeenAtA > 0, "the forged OPEN is rejected with max-ports");

    // Ceiling: onPort was never called for the forged, over-the-limit id —
    // only the two legitimate opens produced a port.
    expect(acceptedIds).toEqual(["one", "two"]);
  });

  it("ignores a duplicate OPEN for an id already in use", async () => {
    const { a, b } = newChannel();
    const opened: unknown[] = [];
    const delivered: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port, meta) => {
          opened.push(meta);
          port.addEventListener("message", (event) => {
            delivered.push(event.data);
          });
        },
      }),
    );

    // Forge two OPEN envelopes for the same id directly on the wire — a peer
    // bug the duplicate guard exists to survive, since accepting the second
    // would silently replace the first consumer's handle.
    a.postMessage({ type: "open", id: 10, meta: "first" });
    a.postMessage({ type: "open", id: 10, meta: "second" });
    a.postMessage({ type: "message", id: 10, payload: "hi" });
    await waitFor(() => delivered.length > 0, "the message reaches the surviving handle");

    // Ceiling: only the first OPEN produced a port.
    expect(opened).toEqual(["first"]);
    // Floor: the surviving handle still works.
    expect(delivered).toEqual(["hi"]);
  });

  it("does not let a local openPort silently replace a handle a hostile peer's OPEN already claimed", async () => {
    const { a, b } = newChannel();
    const acceptedIds: unknown[] = [];
    const messagesForHostileId: unknown[] = [];
    const client = track(
      multiplexPort(a, {
        codec: structuredCodec,
        // default side: "initiator" — allocates ids 0, 2, 4, ...
        onPort: (port, meta) => {
          acceptedIds.push(meta);
          port.addEventListener("message", (event) => {
            messagesForHostileId.push(event.data);
          });
        },
      }),
    );

    // Watch the wire for the id the local openPort actually announces.
    const openIdsOnWire: number[] = [];
    b.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "open") openIdsOnWire.push(envelope.id);
    });
    b.start();

    // A hostile or misconfigured peer opens using the initiator's own
    // parity — id 0, the very id the initiator's allocator would hand out
    // first. Two conforming `multiplexPort` peers cannot trigger this; it
    // takes a peer that ignores the even/odd convention.
    b.postMessage({ type: "open", id: 0, meta: "hostile" });
    await waitFor(() => acceptedIds.length > 0, "the hostile OPEN is accepted");

    // The initiator's own first local open would naively also compute id 0.
    const localPort = client.openPort("local");
    await waitFor(() => openIdsOnWire.length > 0, "the local open reaches the wire");

    // Ceiling: the local open did not reuse the hostile peer's id.
    expect(openIdsOnWire).toEqual([2]);

    // Floor: traffic for id 0 still routes to the originally accepted
    // handle, not to the newly opened local port.
    b.postMessage({ type: "message", id: 0, payload: "still-hostile" });
    await waitFor(
      () => messagesForHostileId.length > 0,
      "id 0 still routes to the originally accepted handle",
    );
    expect(messagesForHostileId).toEqual(["still-hostile"]);
    expect(acceptedIds).toEqual(["hostile"]);

    void localPort;
  });

  it("closes every live virtual port and tears down the underlying port on close()", async () => {
    const { target, closeCalls } = fakeTarget();
    const mux = multiplexPort(target, { codec: structuredCodec });

    const port = mux.openPort();
    const events: unknown[] = [];
    port.addEventListener("message", (event) => {
      events.push(event);
    });
    // Sanity: the port is live before close() — postMessage does not throw.
    expect(() => port.postMessage("x")).not.toThrow();

    await mux.close();

    // The underlying port's close() was invoked exactly once.
    expect(closeCalls()).toBe(1);
    // And the virtual port opened before close() is now inert: postMessage
    // is a silent no-op rather than reaching the (torn-down) underlying port.
    expect(() => port.postMessage("y")).not.toThrow();
  });

  it("removes its own message listener from the underlying port on close()", async () => {
    const { target, added, removed } = fakeTarget();
    const mux = multiplexPort(target, { codec: structuredCodec });

    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);

    await mux.close();

    // The exact listener function registered at construction is the one
    // removed — not merely "some listener, some type".
    expect(removed).toEqual(added);
  });

  it("refuses to open a port after the mux is closed", async () => {
    const { a } = newChannel();
    const client = multiplexPort(a, { codec: structuredCodec });

    await client.close();

    expect(() => client.openPort()).toThrow(/closed/);
  });

  it("drops post() as a no-op once the mux is closed, with no throw", async () => {
    // post() is reached from three call sites once the mux is open: the
    // handleEnvelope open/reject/max-ports branches, attach's send/
    // requestClose closures, and openPort. Each of those is independently
    // guarded before it can reach post() after close() (handleEnvelope has
    // its own top-of-function muxClosed check; every live handle is marked
    // closed, at the virtual-port layer, before muxClosed flips; openPort
    // checks muxClosed before doing anything else) — so this exercises the
    // whole closed-mux surface via the public API, on the theory that if any
    // path *can* still reach post() after close(), this is where it would
    // show up as a thrown error or a message still hitting the wire.
    const { target } = fakeTarget();
    let postMessageCalls = 0;
    target.postMessage = () => {
      postMessageCalls++;
    };
    const mux = multiplexPort(target, { codec: structuredCodec });
    const port = mux.openPort();

    await mux.close();
    const callsAtClose = postMessageCalls;

    expect(() => port.postMessage("late")).not.toThrow();
    expect(() => mux.openPort()).toThrow();

    // Ceiling: nothing further reached the wire through either path.
    expect(postMessageCalls).toBe(callsAtClose);
  });
});
