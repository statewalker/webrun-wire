import { describe, expect, it } from "vitest";
import { getPortCloseSignal, type MessageTarget, setPortCloseSignal } from "../src/index.js";

describe("a port's close signal can travel on the port itself", () => {
  const port = (closeSignal?: AbortSignal): MessageTarget => ({
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    closeSignal,
  });

  it("getPortCloseSignal reads a `closeSignal` the port carries, so an adapter needs no import", () => {
    const life = new AbortController();
    expect(getPortCloseSignal(port(life.signal))).toBe(life.signal);
  });

  it("a signal registered with setPortCloseSignal still wins", () => {
    const own = new AbortController();
    const registered = new AbortController();
    const p = port(own.signal);
    setPortCloseSignal(p, registered.signal);
    expect(getPortCloseSignal(p)).toBe(registered.signal);
  });

  it("a port with neither has none", () => {
    expect(getPortCloseSignal(port())).toBeUndefined();
  });
});
