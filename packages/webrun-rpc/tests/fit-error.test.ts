import { describe, expect, it } from "vitest";
import { encodedSizeEstimate, fitSerializedError } from "../src/fit-error.js";

describe("fitSerializedError (review of #106: errors were sent whole, past maxMessageSize)", () => {
  it("leaves an error that fits unchanged", () => {
    const e = { message: "boom", stack: "Error: boom\n at x", code: 7 };
    expect(fitSerializedError(e, 10_000)).toEqual(e);
  });

  it("drops the stack first, then the largest extra fields, and marks the result truncated", () => {
    const e = {
      message: "http 500",
      stack: `Error: http 500\n${"  at frame\n".repeat(500)}`,
      body: "b".repeat(5000),
      status: 500,
    };
    const fitted = fitSerializedError(e, 1000);
    expect(fitted.message).toBe("http 500");
    expect(fitted.status).toBe(500);
    expect(fitted.stack).toBeUndefined();
    expect(fitted.body).toBeUndefined();
    expect(fitted.truncated).toBe(true);
    expect(encodedSizeEstimate(fitted)).toBeLessThanOrEqual(1000);
  });

  it("the stack goes before a larger field: what identifies the failure outlives the trace", () => {
    const e = { message: "m", stack: "s".repeat(400), detail: "d".repeat(600) };
    const fitted = fitSerializedError(e, 700);
    expect(fitted.stack).toBeUndefined();
    expect(fitted.detail).toBe(e.detail);
  });

  it("truncates the message last, keeping its start", () => {
    const fitted = fitSerializedError({ message: "x".repeat(20_000) }, 1000);
    expect(fitted.message.startsWith("xxxx")).toBe(true);
    expect(fitted.message.endsWith("[truncated]")).toBe(true);
    expect(encodedSizeEstimate(fitted)).toBeLessThanOrEqual(1000);
  });

  it("counts UTF-8 bytes, not characters, and binary fields by their length", () => {
    expect(encodedSizeEstimate("é")).toBeGreaterThanOrEqual(2);
    expect(encodedSizeEstimate(new Uint8Array(500))).toBeGreaterThanOrEqual(500);
    const fitted = fitSerializedError({ message: "é".repeat(3000) }, 1000);
    // measured independently of the estimator under test
    expect(new TextEncoder().encode(fitted.message).byteLength).toBeLessThanOrEqual(1000);
  });
});
