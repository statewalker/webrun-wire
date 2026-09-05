import { describe, expect, it, vi } from "vitest";
import { newVirtualPort } from "../src/virtual-port.js";

describe("virtual port", () => {
  it("forwards postMessage to its send function, transfer list included", () => {
    const send = vi.fn();
    const { port } = newVirtualPort(send, () => {});
    const buffer = new ArrayBuffer(4);
    port.postMessage({ a: 1 }, [buffer]);
    expect(send).toHaveBeenCalledWith({ a: 1 }, [buffer]);
  });

  it("delivers inbound payloads to every registered listener", () => {
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const seen: unknown[] = [];
    port.addEventListener("message", (event) => {
      seen.push(event.data);
    });
    port.addEventListener("message", (event) => {
      seen.push(event.data);
    });
    deliver("hello");
    expect(seen).toEqual(["hello", "hello"]);
  });

  it("stops delivering to a removed listener but keeps the others", () => {
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const kept: unknown[] = [];
    const dropped: unknown[] = [];
    const keptListener = (event: MessageEvent) => {
      kept.push(event.data);
    };
    const droppedListener = (event: MessageEvent) => {
      dropped.push(event.data);
    };
    port.addEventListener("message", keptListener);
    port.addEventListener("message", droppedListener);
    port.removeEventListener("message", droppedListener);
    deliver(1);
    // Floor as well as ceiling: the kept listener proves delivery still works,
    // so an empty `dropped` is evidence rather than an accident.
    expect(kept).toEqual([1]);
    expect(dropped).toEqual([]);
  });

  it("asks the multiplexer to close, exactly once", () => {
    const requestClose = vi.fn();
    const { port } = newVirtualPort(() => {}, requestClose);
    port.close?.();
    port.close?.();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("ignores posts and deliveries once closed", () => {
    const send = vi.fn();
    const { port, deliver, markClosed } = newVirtualPort(send, () => {});
    const seen: unknown[] = [];
    port.addEventListener("message", (event) => {
      seen.push(event.data);
    });

    deliver("before");
    port.postMessage("out");
    markClosed();
    deliver("after");
    port.postMessage("out-after");

    expect(seen).toEqual(["before"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("out", undefined);
  });

  it("survives a listener that throws", () => {
    // One bad consumer must not stop the others from seeing the message, and
    // must not take down the multiplexer's inbound loop.
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const seen: unknown[] = [];
    port.addEventListener("message", () => {
      throw new Error("listener blew up");
    });
    port.addEventListener("message", (event) => {
      seen.push(event.data);
    });
    expect(() => deliver("x")).not.toThrow();
    expect(seen).toEqual(["x"]);
  });

  it("ignores delivery to a listener added after markClosed", () => {
    // addEventListener has no closed check, so a listener can be registered
    // after markClosed() is called. The deliver guard is the only thing
    // preventing delivery to that listener on a closed port.
    const { port, deliver, markClosed } = newVirtualPort(
      () => {},
      () => {},
    );
    const seen: unknown[] = [];
    markClosed();
    port.addEventListener("message", (event) => {
      seen.push(event.data);
    });
    deliver("x");
    expect(seen).toEqual([]);
  });

  it("delivers to a listener added before the port closes", () => {
    // Floor: the identical setup without close must deliver, so the ceiling
    // test's empty array is evidence the guard worked, not an accident.
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const seen: unknown[] = [];
    port.addEventListener("message", (event) => {
      seen.push(event.data);
    });
    deliver("x");
    expect(seen).toEqual(["x"]);
  });
});
