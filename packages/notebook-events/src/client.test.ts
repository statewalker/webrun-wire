import { describe, expect, it, vi } from "vitest";
import { newPubSubClient } from "./client.js";

/** Minimal EventSource stand-in; vitest runs under Node, which has no DOM one. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    let s = this.listeners.get(type);
    if (!s) this.listeners.set(type, (s = new Set()));
    s.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string, lastEventId = "1") {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data, lastEventId } as MessageEvent);
    }
  }
}

describe("newPubSubClient", () => {
  it("opens one EventSource per topic at the right URL", () => {
    FakeEventSource.instances.length = 0;
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    });
    client.subscribe("build", () => {});
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("http://h/_events/build");
  });

  it("parses the JSON payload and reports the event id", () => {
    FakeEventSource.instances.length = 0;
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    });
    const seen: Array<[unknown, number]> = [];
    client.subscribe("build", (data, e) => seen.push([data, e.id]));
    FakeEventSource.instances[0]!.emit("message", '{"changed":["/a.html"]}', "4");
    expect(seen).toEqual([[{ changed: ["/a.html"] }, 4]]);
  });

  it("closes the EventSource on unsubscribe", () => {
    FakeEventSource.instances.length = 0;
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    });
    const off = client.subscribe("build", () => {});
    off();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  // (4) the client half of the gap contract
  it("routes a gap event to onGap and not to the subscriber", () => {
    FakeEventSource.instances.length = 0;
    const onGap = vi.fn();
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      onGap,
    });
    const seen: unknown[] = [];
    client.subscribe("build", (d) => seen.push(d));
    FakeEventSource.instances[0]!.emit("gap", '{"from":1}');
    expect(onGap).toHaveBeenCalledWith("build");
    expect(seen).toEqual([]);
  });
});
