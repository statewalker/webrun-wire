import { describe, expect, it } from "vitest";
import { resolveServiceKey } from "../src/relay/index-sw.js";
import { newMountTable } from "../src/relay/mount-table.js";

const ORIGIN = "https://session.example";
const at = (path: string): URL => new URL(path, ORIGIN);

describe("what the relay worker answers", () => {
  it("a mounted path resolves to its key", () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    expect(resolveServiceKey(at("/peers/x"), table, ORIGIN)).toBe("mesh");
  });

  it("falls back to /~key/ when no mount matches", () => {
    const table = newMountTable();
    expect(resolveServiceKey(at("/~FS/a.txt"), table, ORIGIN)).toBe("FS");
  });

  // THE RULE THE WHOLE DESIGN RESTS ON: not ours means not answered, so the
  // request reaches the network. A 404 here would stop a host serving its own
  // files from its own origin.
  it("an unmounted, non-service path belongs to nobody", () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    expect(resolveServiceKey(at("/index.html"), table, ORIGIN)).toBeUndefined();
  });

  it("a mount wins over the /~key/ spelling", () => {
    const table = newMountTable();
    table.set("app", { path: "/" });
    expect(resolveServiceKey(at("/~FS/a.txt"), table, ORIGIN)).toBe("app");
  });

  it("another origin is never the relay's", () => {
    const table = newMountTable();
    table.set("app", { path: "/" });
    expect(
      resolveServiceKey(new URL("https://elsewhere.example/x"), table, ORIGIN),
    ).toBeUndefined();
  });

  it("an excluded path is nobody's, even under a root mount", () => {
    const table = newMountTable({ exclude: (url) => url.pathname === "/relay.html" });
    table.set("app", { path: "/" });
    expect(resolveServiceKey(at("/relay.html"), table, ORIGIN)).toBeUndefined();
  });
});
