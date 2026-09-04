import { describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/index.js";

describe("MessageTarget", () => {
  it("is satisfied structurally by a MessagePort", () => {
    const { port1 } = new MessageChannel();
    const target: MessageTarget = port1;
    expect(typeof target.postMessage).toBe("function");
    expect(typeof target.addEventListener).toBe("function");
    port1.close();
  });

  it("is satisfied by a minimal hand-rolled object", () => {
    const target: MessageTarget = {
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
    };
    expect(typeof target.postMessage).toBe("function");
  });
});
