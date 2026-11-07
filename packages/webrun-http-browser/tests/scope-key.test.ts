import { describe, expect, it } from "vitest";
import { scopeKey } from "../src/sw/http-sw-dispatcher.js";

describe("scopeKey: the dispatcher's default key", () => {
  const scope = "https://app.test/base/";
  const key = (href: string) => scopeKey(new URL(href), scope);

  it("is the first path segment under the scope, decoded", () => {
    expect(key("https://app.test/base/site/a/b?q=1#h")).toBe("site");
    expect(key("https://app.test/base/my%20site/")).toBe("my site");
    expect(key("https://app.test/base/site?q")).toBe("site");
  });

  it("is none at the scope itself, outside it, or on another origin", () => {
    expect(key("https://app.test/base/")).toBeUndefined();
    expect(key("https://app.test/other/site/")).toBeUndefined();
    expect(key("https://elsewhere.test/base/site/")).toBeUndefined();
  });
});
