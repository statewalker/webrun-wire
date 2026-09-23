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
