/**
 * Firefox has no `Request.prototype.body` (checked against 155):
 * `Object.getOwnPropertyDescriptor(Request.prototype, "body")` is `null`
 * there, so `request.body` reads as `undefined` even for a genuine payload.
 * `urlUpstream` used to rebuild the outbound request with `body:
 * request.body`, which is silently bodyless in that engine while working in
 * Chromium, where the property is a stream. This is the fifth site of the
 * same defect — four already fixed in `statewalker/httpeers`
 * (`edge-dispatch.ts`, two in `core/router.ts`, a demo page) — found in
 * production as a POST arriving `0 bytes of 76 sent`, Firefox only.
 *
 * Rather than require a browser, `Object.defineProperty` hides the property
 * on a real `Request` the same way Firefox's own prototype does, and the
 * assertion below is on the bytes that arrived at the upstream server — not
 * on a status code, which stayed 200 throughout even when the body was lost.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { urlUpstream } from "../src/proxy.js";
import { type Fixture, startFixture } from "./fixture-server.js";

/** Hides `body` on a real `Request` the way Firefox's missing accessor does. */
function hideBody(request: Request): Request {
  Object.defineProperty(request, "body", { value: undefined });
  return request;
}

describe("urlUpstream on a runtime without Request.prototype.body (the Firefox shape)", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it("still forwards a POST body upstream when `request.body` is unavailable", async () => {
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });
    const payload = JSON.stringify({ hello: "firefox" });

    const request = hideBody(
      new Request("http://mesh.local/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );

    const res = await upstream(request);
    const arrived = (await res.json()) as { body: string };

    // Pre-fix, `body: request.body` sent `undefined` through to `new
    // Request(...)`, which silently drops it — the upstream saw an empty body
    // and this assertion failed with `arrived.body === ""`.
    expect(arrived.body).toBe(payload);
  });

  it("frames no body at all for a genuinely empty one, same as the streaming path", async () => {
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });

    const request = hideBody(new Request("http://mesh.local/x", { method: "POST" }));

    const res = await upstream(request);
    const arrived = (await res.json()) as { body: string };

    expect(arrived.body).toBe("");
  });

  it("leaves GET alone — no body is buffered or sent", async () => {
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });

    const request = hideBody(new Request("http://mesh.local/x", { method: "GET" }));

    const res = await upstream(request);
    const arrived = (await res.json()) as { body: string };

    expect(arrived.body).toBe("");
  });

  it("still streams chunk by chunk when `request.body` is available", async () => {
    // No hiding here: the untouched path a real Chromium/Node request takes.
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first-"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    });
    const request = new Request("http://mesh.local/x", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    const res = await upstream(request);
    const arrived = (await res.json()) as { body: string };

    expect(arrived.body).toBe("first-second");
  });
});
