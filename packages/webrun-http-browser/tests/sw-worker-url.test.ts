/**
 * `serviceWorkerUrl` must accept the form everyone actually writes.
 *
 * A ServiceWorker has to be served from a path whose scope covers the site,
 * so callers naturally pass a ROOT-RELATIVE url — `"/sw-worker.js"` — which
 * is also what `HostedSiteBuilder` documents. `SwPortHandler` resolved it
 * with a bare `new URL(...)`, so that threw
 * `TypeError: Failed to construct 'URL': Invalid URL` from the CONSTRUCTOR
 * (via the `scope` getter), naming neither the option nor the value.
 *
 * A url is relative to the document that registers the worker, so it is
 * resolved against `location.href` like every other url a page writes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SwPortHandler } from "../src/sw/sw-dispatcher.js";

const original = Object.getOwnPropertyDescriptor(globalThis, "location");

function atPage(href: string): void {
  Object.defineProperty(globalThis, "location", {
    value: new URL(href),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "location", original);
  else Reflect.deleteProperty(globalThis as object, "location");
});

describe("SwPortHandler: resolving serviceWorkerUrl", () => {
  const bindPort = (): void => {};

  it("accepts a root-relative url", () => {
    atPage("http://localhost:4173/app/index.html");
    const handler = new SwPortHandler({ key: "mesh", serviceWorkerUrl: "/sw-worker.js", bindPort });
    expect(handler.serviceWorkerUrl).toBe("http://localhost:4173/sw-worker.js");
    // The scope follows from it: a worker at the root covers the whole origin.
    expect(handler.scope).toBe("/");
  });

  it("accepts a document-relative url", () => {
    atPage("http://localhost:4173/app/index.html");
    const handler = new SwPortHandler({ key: "mesh", serviceWorkerUrl: "sw.js", bindPort });
    expect(handler.serviceWorkerUrl).toBe("http://localhost:4173/app/sw.js");
    expect(handler.scope).toBe("/app/");
  });

  it("leaves an absolute url alone", () => {
    atPage("http://localhost:4173/app/index.html");
    const handler = new SwPortHandler({
      key: "mesh",
      serviceWorkerUrl: "http://localhost:4173/w/sw.js",
      bindPort,
    });
    expect(handler.serviceWorkerUrl).toBe("http://localhost:4173/w/sw.js");
  });

  it("reports WHICH option was wrong when the url cannot be resolved", () => {
    atPage("http://localhost:4173/app/index.html");
    expect(
      () => new SwPortHandler({ key: "mesh", serviceWorkerUrl: "http://[bad", bindPort }),
    ).toThrow(/serviceWorkerUrl/);
  });
});
