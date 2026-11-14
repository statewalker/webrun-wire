import { describe, expect, it } from "vitest";
import * as rpc from "../src/index.js";

// statewalker/webrun-wire#150: the misspelt names stay exported as aliases.
describe("receive: deprecated alias", () => {
  it("exports `recieve` as the same function as `receive`", () => {
    expect(rpc.receive).toBeTypeOf("function");
    expect(rpc.recieve).toBe(rpc.receive);
  });
});
