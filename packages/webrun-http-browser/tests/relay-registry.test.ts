import { describe, expect, it } from "vitest";
import { readStoredEntry } from "../src/relay/index-sw.js";

describe("the relay's stored registrations", () => {
  it("reads the shape written today", () => {
    expect(readStoredEntry({ clientId: "abc", path: "/peers/" })).toEqual({
      clientId: "abc",
      path: "/peers/",
    });
  });

  // A RETURNING VISITOR'S DATABASE. Before mounts, the registry stored the
  // client id as a bare string. A browser that ran the old worker still has
  // that shape on disk, and reading it as an object would drop the id and
  // silently unregister every service.
  it("reads the shape the pre-mounts worker wrote", () => {
    expect(readStoredEntry("abc")).toEqual({ clientId: "abc" });
  });

  it("refuses anything else rather than inventing a client", () => {
    expect(readStoredEntry(null)).toBeUndefined();
    expect(readStoredEntry({ path: "/x/" })).toBeUndefined();
  });
});
