import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http-error.js";

describe("HttpError", () => {
  it("stores status and statusText from options", () => {
    const err = new HttpError({ status: 418, statusText: "I'm a teapot", message: "coffee" });
    expect(err.status).toBe(418);
    expect(err.statusText).toBe("I'm a teapot");
    expect(err.message).toBe("coffee");
  });

  it("toJson exposes core fields", () => {
    const err = new HttpError({ status: 500, statusText: "ISE", message: "bad" });
    expect(err.toJson()).toEqual({ status: 500, statusText: "ISE", message: "bad" });
  });

  it("getResponseOptions merges extra fields last", () => {
    const err = new HttpError({ status: 404, statusText: "NF", message: "missing" });
    expect(err.getResponseOptions({ headers: { "X-A": "b" } })).toEqual({
      status: 404,
      statusText: "NF",
      message: "missing",
      headers: { "X-A": "b" },
    });
  });

  it("fromError passes through existing HttpError", () => {
    const orig = new HttpError({ status: 403, statusText: "Forbidden" });
    expect(HttpError.fromError(orig)).toBe(orig);
  });

  it("fromError wraps plain Error into 500", () => {
    const wrapped = HttpError.fromError(new Error("kaboom"));
    expect(wrapped.status).toBe(500);
    expect(wrapped.message).toBe("kaboom");
  });

  it.each([
    ["errorResourceNotFound", 404],
    ["errorForbidden", 403],
    ["errorResourceGone", 410],
    ["errorInternalError", 500],
  ] as const)("%s returns status %i", (factory, status) => {
    const err = HttpError[factory]();
    expect(err.status).toBe(status);
  });
});
