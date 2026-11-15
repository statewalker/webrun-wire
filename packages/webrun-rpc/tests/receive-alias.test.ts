import { describe, expect, it } from "vitest";
import * as rpc from "../src/index.js";

// statewalker/webrun-wire#150: the misspelt aliases were dropped in a breaking minor.
describe("receive", () => {
  it("is exported, and the misspelt alias `recieve` is gone", () => {
    expect(rpc.receive).toBeTypeOf("function");
    expect(rpc).not.toHaveProperty("recieve");
  });
});
