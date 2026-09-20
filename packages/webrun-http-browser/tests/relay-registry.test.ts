import { describe, expect, it } from "vitest";
import { mayRegister, readStoredEntry } from "../src/relay/index-sw.js";

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

describe("who keeps a service key", () => {
  it("last-wins lets a second client take over, as before", () => {
    expect(
      mayRegister({
        current: { clientId: "first" },
        candidateId: "second",
        isCurrentLive: true,
        takeover: "last-wins",
      }),
    ).toBe(true);
  });

  // THE NAME OF A RELAY ORIGIN IS NOT A SECRET. Where it is guessable, a
  // second page on the origin must not be able to take a live service.
  it("first-wins refuses a second client while the first is live", () => {
    expect(
      mayRegister({
        current: { clientId: "first" },
        candidateId: "second",
        isCurrentLive: true,
        takeover: "first-wins",
      }),
    ).toBe(false);
  });

  it("first-wins lets the same client re-register", () => {
    expect(
      mayRegister({
        current: { clientId: "first" },
        candidateId: "first",
        isCurrentLive: true,
        takeover: "first-wins",
      }),
    ).toBe(true);
  });

  // A host that reloads loses its client; its own re-registration must work.
  it("first-wins accepts a newcomer once the holder is gone", () => {
    expect(
      mayRegister({
        current: { clientId: "first" },
        candidateId: "second",
        isCurrentLive: false,
        takeover: "first-wins",
      }),
    ).toBe(true);
  });

  it("an unheld key is free", () => {
    expect(
      mayRegister({ candidateId: "first", isCurrentLive: false, takeover: "first-wins" }),
    ).toBe(true);
  });
});
