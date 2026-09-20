import { describe, expect, it, vi } from "vitest";
import {
  applyRegisteredMount,
  removeRegisteredMount,
  resolveAfterRestore,
  resolveServiceKey,
} from "../src/relay/index-sw.js";
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

describe("restoring the mount table before routing", () => {
  // THE OTHER RULE THIS DESIGN RESTS ON: a restore failure must not turn every
  // fetch into a network error. If it did, a page's own assets -- which route
  // by falling through resolveServiceKey to undefined -- would break exactly
  // when the registry is least available.
  it("a rejected restore still routes; an unmounted path still reaches the network", async () => {
    const table = newMountTable();
    const restored = Promise.reject(new Error("indexeddb blocked"));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const key = await resolveAfterRestore(restored, at("/index.html"), table, ORIGIN);
      expect(key).toBeUndefined();
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a rejected restore still routes an already-mounted path", async () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    const restored = Promise.reject(new Error("indexeddb blocked"));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const key = await resolveAfterRestore(restored, at("/peers/x"), table, ORIGIN);
      expect(key).toBe("mesh");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("a successful restore routes normally", async () => {
    const table = newMountTable();
    table.set("mesh", { path: "/peers/" });
    const key = await resolveAfterRestore(Promise.resolve(), at("/peers/x"), table, ORIGIN);
    expect(key).toBe("mesh");
  });
});

describe("what REGISTER does to the mount table", () => {
  it("re-registering without a path drops the earlier mount and falls back to /~key/", () => {
    const table = newMountTable();
    applyRegisteredMount(table, "mesh", "/peers/");
    expect(resolveServiceKey(at("/peers/x"), table, ORIGIN)).toBe("mesh");

    applyRegisteredMount(table, "mesh", undefined);
    expect(resolveServiceKey(at("/peers/x"), table, ORIGIN)).toBeUndefined();
    expect(resolveServiceKey(at("/~mesh/a.txt"), table, ORIGIN)).toBe("mesh");
  });

  it("registering with a path mounts it", () => {
    const table = newMountTable();
    applyRegisteredMount(table, "mesh", "/peers/");
    expect(resolveServiceKey(at("/peers/x"), table, ORIGIN)).toBe("mesh");
  });

  // A mount the HOST declared is not a registration's to undo: the static
  // flow registers the key with no path at all, and that must not wipe it.
  it("leaves a host-declared key alone, path or no path", () => {
    const table = newMountTable();
    table.set("app", { path: "/" });
    const hostKeys = new Set(["app"]);

    applyRegisteredMount(table, "app", undefined, hostKeys);
    expect(resolveServiceKey(at("/index.html"), table, ORIGIN)).toBe("app");

    applyRegisteredMount(table, "app", "/elsewhere/", hostKeys);
    expect(resolveServiceKey(at("/index.html"), table, ORIGIN)).toBe("app");

    removeRegisteredMount(table, "app", hostKeys);
    expect(resolveServiceKey(at("/index.html"), table, ORIGIN)).toBe("app");
  });

  it("UNREGISTER drops a mount a registration made", () => {
    const table = newMountTable();
    applyRegisteredMount(table, "mesh", "/peers/", new Set(["app"]));
    removeRegisteredMount(table, "mesh", new Set(["app"]));
    expect(resolveServiceKey(at("/peers/x"), table, ORIGIN)).toBeUndefined();
  });
});
