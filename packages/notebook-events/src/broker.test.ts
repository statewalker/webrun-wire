import { describe, expect, it } from "vitest";
import type { BrokerEvent } from "./broker.js";
import { newBroker } from "./broker.js";

describe("newBroker", () => {
  it("delivers a published event to a subscriber on the same topic", () => {
    const broker = newBroker();
    const seen: unknown[] = [];
    broker.subscribe("build", (e) => seen.push(e.data));
    broker.publish("build", { changed: ["/a.html"] });
    expect(seen).toEqual([{ changed: ["/a.html"] }]);
  });

  it("does not deliver across topics", () => {
    const broker = newBroker();
    const seen: unknown[] = [];
    broker.subscribe("build", (e) => seen.push(e.data));
    broker.publish("other", { changed: [] });
    expect(seen).toEqual([]);
  });

  it("assigns monotonically increasing ids per topic", () => {
    const broker = newBroker();
    const a = broker.publish("t", 1);
    const b = broker.publish("t", 2);
    expect(b.id).toBeGreaterThan(a.id);
  });

  // (2) a publish with no subscribers must not throw and must still advance the id
  it("advances the id when nobody is listening", () => {
    const broker = newBroker();
    const first = broker.publish("quiet", "a");
    const second = broker.publish("quiet", "b");
    expect(second.id).toBe(first.id + 1);
    const { events } = broker.replay("quiet", first.id);
    expect(events.map((e) => e.data)).toEqual(["b"]);
  });
});

describe("newBroker — concurrency and lifecycle", () => {
  // (5) S2 proved exactly one subscriber; a single-callback broker passes every such test
  it("delivers to every subscriber on a topic", () => {
    const broker = newBroker();
    const a: unknown[] = [];
    const b: unknown[] = [];
    broker.subscribe("t", (e) => a.push(e.data));
    broker.subscribe("t", (e) => b.push(e.data));
    broker.publish("t", "x");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
    expect(broker.subscriberCount("t")).toBe(2);
  });

  // (1) a disconnecting subscriber must be dropped, or a long-lived server leaks
  it("releases one subscriber's slot without disturbing the other", () => {
    const broker = newBroker();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = broker.subscribe("t", (e) => a.push(e.data));
    broker.subscribe("t", (e) => b.push(e.data));
    expect(broker.subscriberCount("t")).toBe(2);

    broker.publish("t", "before");
    offA();
    broker.publish("t", "after");

    expect(a).toEqual(["before"]);
    expect(b).toEqual(["before", "after"]);
    expect(broker.subscriberCount("t")).toBe(1);
  });

  it("tolerates a subscriber unsubscribing during delivery", () => {
    const broker = newBroker();
    const seen: unknown[] = [];
    const off = broker.subscribe("t", () => off());
    broker.subscribe("t", (e) => seen.push(e.data));
    expect(broker.subscriberCount("t")).toBe(2);

    expect(() => broker.publish("t", "x")).not.toThrow();

    expect(seen).toEqual(["x"]);
    expect(broker.subscriberCount("t")).toBe(1); // the self-unsubscriber removed itself
  });

  // Pins the `[...s.subscribers]` copy in publish(). Self-unsubscribe is safe in
  // every engine, so it proves nothing; only removing a NOT-YET-VISITED entry does.
  it("delivers to a not-yet-visited subscriber even if an earlier callback unsubscribes it", () => {
    const broker = newBroker();
    const seenC: unknown[] = [];
    let offC!: () => void;
    broker.subscribe("t", () => offC()); // A: runs first, unsubscribes C
    broker.subscribe("t", () => {}); // B: filler, keeps C unvisited when A runs
    offC = broker.subscribe("t", (e) => seenC.push(e.data)); // C
    broker.publish("t", "x");
    expect(seenC).toEqual(["x"]); // only true because publish snapshots up front
  });
});

describe("newBroker — a failing subscriber", () => {
  // C-1: a bare `for … fn(e)` lets the first throwing subscriber abort delivery to
  // everyone after it and propagate the throw out of publish().
  it("isolates a throwing subscriber from the others and from the publisher", () => {
    const errors: unknown[] = [];
    const broker = newBroker({ onSubscriberError: (err) => errors.push(err) });
    const seen: unknown[] = [];
    broker.subscribe("t", () => {
      throw new Error("boom");
    });
    broker.subscribe("t", (e) => seen.push(e.data));

    expect(() => broker.publish("t", "x")).not.toThrow();

    expect(seen).toEqual(["x"]); // the second subscriber was not starved
    expect(errors).toHaveLength(1);
  });
});

describe("newBroker — replay completeness", () => {
  // C-2: the ceiling. A client whose id came from a previous server epoch asks for
  // events above the newest id ever issued; reporting `complete` there tells a stale
  // page it is current, and onGap never fires.
  it("reports an incomplete history when afterId is above the newest id", () => {
    const broker = newBroker();
    broker.publish("t", "a");
    broker.publish("t", "b");
    expect(broker.replay("t", 42)).toEqual({ events: [], complete: false });
  });

  it("treats an unknown topic as complete only for a client with no history", () => {
    const broker = newBroker();
    expect(broker.replay("absent", 0)).toEqual({ events: [], complete: true });
    expect(broker.replay("absent", 7)).toEqual({ events: [], complete: false });
  });

  // m-8: with an empty ring every replay used to report complete, disabling the contract.
  it("retains nothing with bufferSize 0, so only a level client is complete", () => {
    const broker = newBroker({ bufferSize: 0 });
    broker.publish("t", "a");
    broker.publish("t", "b");
    expect(broker.replay("t", 0).complete).toBe(false);
    expect(broker.replay("t", 1).complete).toBe(false);
    expect(broker.replay("t", 2)).toEqual({ events: [], complete: true });
    expect(broker.replay("t", 3).complete).toBe(false);
  });

  it("is complete at the first retained event and incomplete one event earlier", () => {
    const broker = newBroker({ bufferSize: 2 });
    for (const d of ["a", "b", "c"]) broker.publish("t", d); // ids 1..3; the ring holds 2,3
    const at = broker.replay("t", 1);
    expect(at.complete).toBe(true);
    expect(at.events.map((e) => e.data)).toEqual(["b", "c"]);
    expect(broker.replay("t", 0).complete).toBe(false); // id 1 was evicted
  });
});

describe("newBroker — subscribe's shape", () => {
  // I-3: the lastEventId parameter discarded `complete` (the C-2 miss, on the public
  // interface) and reached replay through `this`, so a destructured subscribe threw.
  it("takes exactly two arguments, never replays, and does not depend on `this`", () => {
    const { subscribe, publish, subscriberCount } = newBroker();
    publish("t", "before");

    const seen: unknown[] = [];
    const loose = subscribe as unknown as (...args: unknown[]) => () => void;
    const off = loose("t", (e: BrokerEvent) => seen.push(e.data), 0);

    expect(seen).toEqual([]); // no replay on subscribe: callers use replay() and read `complete`
    expect(subscribe.length).toBe(2);
    publish("t", "after");
    expect(seen).toEqual(["after"]);
    off();
    expect(subscriberCount("t")).toBe(0);
  });

  // I-6: an entry created by a touch that left nothing behind must not outlive it.
  it("drops a topic once it has no subscribers and nothing retained", () => {
    const broker = newBroker();
    const off = broker.subscribe("ghost", () => {});
    expect(broker.topicCount()).toBe(1);
    off();
    expect(broker.topicCount()).toBe(0);
  });

  it("keeps a topic that still has retained events", () => {
    const broker = newBroker();
    const off = broker.subscribe("t", () => {});
    broker.publish("t", "a");
    off();
    expect(broker.topicCount()).toBe(1);
    expect(broker.replay("t", 0).events.map((e) => e.data)).toEqual(["a"]);
  });
});
