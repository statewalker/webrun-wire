import { describe, expect, it } from "vitest";
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
});
