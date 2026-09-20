import { describe, expect, it } from "vitest";
import { newMountTable } from "../src/relay/mount-table.js";

const at = (path: string): URL => new URL(path, "https://session.example");

describe("mount table", () => {
  it("routes a path to the mount that owns its prefix", () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    expect(table.find(at("/peers/12D3Koo/llm"))).toBe("mesh");
  });

  it("a root mount takes everything else", () => {
    const table = newMountTable();
    table.set("app", { path: "/" });
    expect(table.find(at("/"))).toBe("app");
    expect(table.find(at("/index.html"))).toBe("app");
  });

  // THE POINT OF LONGEST-PREFIX: a catch-all at "/" must not swallow "/peers/".
  it("the longest matching prefix wins, whatever the registration order", () => {
    const table = newMountTable();
    table.set("app", { path: "/" });
    table.set("mesh", { path: "/peers/" });
    expect(table.find(at("/peers/x"))).toBe("mesh");
    expect(table.find(at("/other"))).toBe("app");

    const reverse = newMountTable();
    reverse.set("mesh", { path: "/peers/" });
    reverse.set("app", { path: "/" });
    expect(reverse.find(at("/peers/x"))).toBe("mesh");
  });

  it("a mount owns its own directory, with or without the trailing slash", () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    expect(table.find(at("/peers/"))).toBe("mesh");
    expect(table.find(at("/peers"))).toBe("mesh");
    // A SIBLING IS NOT A CHILD.
    expect(table.find(at("/peersx"))).toBeUndefined();
  });

  it("an unmatched path belongs to nobody", () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    expect(table.find(at("/index.html"))).toBeUndefined();
  });

  it("exclude is checked before the table, so a root mount cannot swallow reserved files", () => {
    const table = newMountTable({ exclude: (url) => url.pathname === "/relay.html" });
    table.set("app", { path: "/" });
    expect(table.find(at("/relay.html"))).toBeUndefined();
    expect(table.find(at("/app.js"))).toBe("app");
  });

  it("a predicate mount is consulted when no prefix matches, in registration order", () => {
    const table = newMountTable();
    table.set("app", { path: "/" });
    table.set("images", { match: (url) => url.pathname.endsWith(".png") });
    // A prefix mount is more specific than a predicate, so "/" still wins here.
    expect(table.find(at("/logo.png"))).toBe("app");

    const noRoot = newMountTable();
    noRoot.set("images", { match: (url) => url.pathname.endsWith(".png") });
    expect(noRoot.find(at("/logo.png"))).toBe("images");
    expect(noRoot.find(at("/logo.gif"))).toBeUndefined();
  });

  it("remove takes a mount out", () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    table.remove("mesh");
    expect(table.find(at("/peers/x"))).toBeUndefined();
  });

  it("re-setting a key replaces its mount rather than adding one", () => {
    const table = newMountTable();
    table.set("svc", { path: "/a/" });
    table.set("svc", { path: "/b/" });
    expect(table.find(at("/a/x"))).toBeUndefined();
    expect(table.find(at("/b/x"))).toBe("svc");
  });
});
