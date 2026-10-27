import { describe, expect, it } from "vitest";
import { type HandlerInfo, HandlerTable, leastInflightRoute } from "../src/sw/handler-table.js";

function entry(key: string, id: string, init: Partial<HandlerInfo> = {}): HandlerInfo {
  return {
    key,
    id,
    owner: `${id}-owner`,
    inflight: 0,
    meta: undefined,
    attachedAt: 0,
    draining: false,
    ...init,
  };
}

const request = new Request("http://x/");

describe("leastInflightRoute", () => {
  it("picks the fewest in flight, the oldest on a tie", () => {
    const a = entry("k", "a", { inflight: 2, attachedAt: 1 });
    const b = entry("k", "b", { inflight: 1, attachedAt: 2 });
    const c = entry("k", "c", { inflight: 1, attachedAt: 3 });
    expect(leastInflightRoute(request, "k", [a, b, c])).toBe(b);
    expect(leastInflightRoute(request, "k", [])).toBeUndefined();
  });
});

describe("HandlerTable", () => {
  it("keeps one entry per slot and reports the one it replaces", () => {
    const table = new HandlerTable<HandlerInfo>();
    const first = entry("k", "slot");
    const second = entry("k", "slot", { owner: "other" });
    expect(table.add(first)).toBeUndefined();
    expect(table.add(second)).toBe(first);
    expect(table.all("k")).toEqual([second]);
    // A stale entry does not remove its successor.
    expect(table.remove(first)).toBe(false);
    expect(table.get("k", "slot")).toBe(second);
    expect(table.remove(second)).toBe(true);
    expect(table.size).toBe(0);
  });

  it("live() leaves draining entries out", () => {
    const table = new HandlerTable<HandlerInfo>();
    table.add(entry("k", "a", { draining: true }));
    table.add(entry("k", "b"));
    expect(table.live("k").map((e) => e.id)).toEqual(["b"]);
    expect(table.all("k")).toHaveLength(2);
  });

  it("waitFor resolves on the next live attach, or false on timeout", async () => {
    const table = new HandlerTable<HandlerInfo>();
    const waiting = table.waitFor("k", 1000);
    table.add(entry("other", "x"));
    table.add(entry("k", "draining", { draining: true }));
    table.add(entry("k", "a"));
    expect(await waiting).toBe(true);
    expect(await table.waitFor("k", 1000)).toBe(true);
    expect(await table.waitFor("k", 20, true)).toBe(false);
    expect(await table.waitFor("none", 20)).toBe(false);
  });
});
