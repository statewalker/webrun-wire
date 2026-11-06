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
    if (!s) {
      s = new Set();
      this.listeners.set(type, s);
    }
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
      fn({ type, data, lastEventId } as MessageEvent);
    }
  }
  /** A bare Event, as `error` and `open` are dispatched. */
  emitBare(type: string) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ type } as MessageEvent);
    }
  }
  listenerTypes() {
    return [...this.listeners]
      .filter(([, fns]) => fns.size > 0)
      .map(([type]) => type)
      .sort();
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

describe("newPubSubClient — event names", () => {
  const newClient = (options: Record<string, unknown> = {}) => {
    FakeEventSource.instances.length = 0;
    return newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      ...options,
    });
  };

  // I-4: per the SSE spec a frame with `event: X` dispatches only as type X, so the
  // three hardcoded listeners silently dropped every other name — and one of them
  // was "rebuilt", notebook vocabulary in a generic package.
  it("listens for `message` and nothing else by default", () => {
    const client = newClient();
    client.subscribe("build", () => {});
    expect(FakeEventSource.instances[0]!.listenerTypes()).toEqual([
      "error",
      "gap",
      "message",
      "open",
    ]);
  });

  it("delivers an arbitrary named event to a subscriber that asked for it", () => {
    const client = newClient();
    const seen: Array<[unknown, string | undefined]> = [];
    client.subscribe("build", (d, e) => seen.push([d, e.event]), { events: ["cell-done"] });
    FakeEventSource.instances[0]!.emit("cell-done", '{"cell":3}', "9");
    expect(seen).toEqual([[{ cell: 3 }, "cell-done"]]);
  });

  it("takes a default event-name set for every subscription on the client", () => {
    const client = newClient({ events: ["message", "rebuilt"] });
    const seen: unknown[] = [];
    client.subscribe("build", (d) => seen.push(d));
    FakeEventSource.instances[0]!.emit("rebuilt", '{"n":1}');
    FakeEventSource.instances[0]!.emit("message", '{"n":2}');
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("removes every listener it added on unsubscribe", () => {
    const client = newClient();
    const off = client.subscribe("build", () => {}, { events: ["message", "cell-done"] });
    off();
    expect(FakeEventSource.instances[0]!.listenerTypes()).toEqual([]);
  });
});

describe("newPubSubClient — a dead subscription", () => {
  // I-5: a real EventSource that gets a non-2xx or a wrong content-type closes for
  // good. With no error listener the page looked healthy and never updated again.
  it("reports a stream error through onError", () => {
    FakeEventSource.instances.length = 0;
    const onError = vi.fn();
    const onOpen = vi.fn();
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      onError,
      onOpen,
    });
    client.subscribe("build", () => {});
    FakeEventSource.instances[0]!.emitBare("open");
    FakeEventSource.instances[0]!.emitBare("error");
    expect(onOpen).toHaveBeenCalledWith("build");
    expect(onError).toHaveBeenCalledWith("build", expect.objectContaining({ type: "error" }));
  });
});

describe("newPubSubClient — reserved control names", () => {
  // `gap`, `error` and `open` are the client's own control channels. Asking for one
  // as a data event handed the gap frame to the data callback — re-opening the one
  // invariant this package exists to protect, since a caller that mistakes a gap for
  // a payload patches forward from a false baseline believing its history complete —
  // and made a real transport error throw SyntaxError from JSON.parse(undefined).
  const reserved = ["gap", "error", "open"];

  it("refuses a reserved name in a subscription's event set, before opening anything", () => {
    FakeEventSource.instances.length = 0;
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    });
    for (const name of reserved) {
      expect(() => client.subscribe("build", () => {}, { events: ["message", name] })).toThrow(
        /reserved/,
      );
    }
    expect(FakeEventSource.instances).toHaveLength(0); // nothing was opened and leaked
  });

  it("refuses a reserved name in the client-wide default set", () => {
    for (const name of reserved) {
      expect(() =>
        newPubSubClient("http://h/_events", {
          EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
          events: [name],
        }),
      ).toThrow(/reserved/);
    }
  });

  it("keeps a gap off the data callback and a transport error harmless", () => {
    FakeEventSource.instances.length = 0;
    const onGap = vi.fn();
    const onError = vi.fn();
    const client = newPubSubClient("http://h/_events", {
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      onGap,
      onError,
    });
    const seen: unknown[] = [];
    expect(() =>
      client.subscribe("build", (d) => seen.push(d), { events: ["gap", "error"] }),
    ).toThrow(/reserved/);

    client.subscribe("build", (d) => seen.push(d));
    const source = FakeEventSource.instances[0]!;
    source.emit("gap", '{"from":1}');
    expect(() => source.emitBare("error")).not.toThrow();

    expect(seen).toEqual([]); // no control frame ever reached the data callback
    expect(onGap).toHaveBeenCalledWith("build");
    expect(onError).toHaveBeenCalled();
  });
});
