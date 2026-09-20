import { describe, expect, it } from "vitest";
import { splitServiceUrl } from "../src/relay/split-service-url.js";

describe("splitServiceUrl", () => {
  it("splits a full URL with path", () => {
    expect(splitServiceUrl("https://host.com/~FS/some/path.txt")).toEqual({
      url: "https://host.com/~FS/some/path.txt",
      key: "FS",
      baseUrl: "https://host.com/~FS/",
      path: "some/path.txt",
    });
  });

  it("splits URL with key only, no trailing slash", () => {
    expect(splitServiceUrl("https://host.com/~FS")).toEqual({
      url: "https://host.com/~FS",
      key: "FS",
      baseUrl: "https://host.com/~FS",
      path: "",
    });
  });

  it("returns empty key/baseUrl/path when no separator present", () => {
    const res = splitServiceUrl("https://host.com/no/service");
    expect(res).toEqual({
      url: "https://host.com/no/service",
      key: "",
      baseUrl: "",
      path: "",
    });
  });

  it("accepts a URL object", () => {
    const res = splitServiceUrl(new URL("https://a.b/~K/x"));
    expect(res.key).toBe("K");
    expect(res.path).toBe("x");
  });

  it("honours a custom separator", () => {
    const res = splitServiceUrl("https://a.b/@SVC/q/r", "@");
    expect(res).toEqual({
      url: "https://a.b/@SVC/q/r",
      key: "SVC",
      baseUrl: "https://a.b/@SVC/",
      path: "q/r",
    });
  });

  // THE DEFECT: the separator was found with `indexOf` on the whole URL
  // string, so anything containing `~` looked like a service URL.
  it("does not treat a query string as a service", () => {
    const res = splitServiceUrl("https://host.com/index.html?q=~foo");
    expect(res.key).toBe("");
    expect(res.baseUrl).toBe("");
    expect(res.path).toBe("");
  });

  it("does not treat a `~` inside a path segment as a service", () => {
    expect(splitServiceUrl("https://host.com/files/a~b/c").key).toBe("");
  });

  it("does not treat a `~` in the fragment as a service", () => {
    expect(splitServiceUrl("https://host.com/page#~FS").key).toBe("");
  });

  it("still splits a service URL that carries a query", () => {
    const res = splitServiceUrl("https://host.com/~FS/a/b.txt?x=1");
    expect(res.key).toBe("FS");
    expect(res.path).toBe("a/b.txt");
  });

  // FIX: preserve the origin from the input, not from the normalized URL
  it("preserves protocol-relative URLs (//host)", () => {
    const res = splitServiceUrl("//host.com/~FS/a");
    expect(res).toEqual({
      url: "//host.com/~FS/a",
      key: "FS",
      baseUrl: "//host.com/~FS/",
      path: "a",
    });
  });

  it("preserves mixed-case schemes", () => {
    const res = splitServiceUrl("HTTPS://host.com/~FS/a");
    expect(res).toEqual({
      url: "HTTPS://host.com/~FS/a",
      key: "FS",
      baseUrl: "HTTPS://host.com/~FS/",
      path: "a",
    });
  });

  // ROOT-RELATIVE INPUT IS THE COMMON CASE for a consumer that passes
  // `location.pathname` or a root-absolute href, and anchoring the separator
  // check to the segment boundary had made it return nothing at all.
  it("splits a root-relative path", () => {
    expect(splitServiceUrl("/~FS/a/b")).toEqual({
      url: "/~FS/a/b",
      key: "FS",
      baseUrl: "/~FS/",
      path: "a/b",
    });
  });

  it("splits a root-relative path with the key only", () => {
    expect(splitServiceUrl("/~FS")).toEqual({
      url: "/~FS",
      key: "FS",
      baseUrl: "/~FS",
      path: "",
    });
  });

  it("a root-relative path with no service is nobody's", () => {
    expect(splitServiceUrl("/index.html")).toEqual({
      url: "/index.html",
      key: "",
      baseUrl: "",
      path: "",
    });
  });

  it("handles relative URLs without injecting a leading slash", () => {
    const res = splitServiceUrl("~FS/a/b");
    expect(res).toEqual({
      url: "~FS/a/b",
      key: "FS",
      baseUrl: "~FS/",
      path: "a/b",
    });
  });
});
