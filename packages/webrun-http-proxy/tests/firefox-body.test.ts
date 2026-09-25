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
 * assertions below are on what actually arrived at the upstream server —
 * bytes, timing, status — never a status code alone, which stayed 200
 * throughout even when the body was lost.
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

  it("POST with a genuinely empty body: the upstream still receives zero bytes, same as the streaming path", async () => {
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });

    const request = hideBody(new Request("http://mesh.local/x", { method: "POST" }));

    const res = await upstream(request);
    const arrived = (await res.json()) as { body: string };

    expect(arrived.body).toBe("");
  });

  it("GET: the upstream receives zero bytes (the body is never buffered — GET is decided before the body is touched at all)", async () => {
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });

    const request = hideBody(new Request("http://mesh.local/x", { method: "GET" }));

    const res = await upstream(request);
    const arrived = (await res.json()) as { body: string };

    expect(arrived.body).toBe("");
  });

  it("HEAD: no body is attached to the outbound request (a HEAD response has none to check upstream, so this inspects the outbound request itself)", async () => {
    let seenMethod: string | undefined;
    let seenBody: BodyInit | null | undefined;
    const upstream = urlUpstream({
      base: `${fixture.origin}/echo`,
      fetchImpl: (async (input: Request) => {
        seenMethod = input.method;
        seenBody = input.body;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    const request = hideBody(new Request("http://mesh.local/x", { method: "HEAD" }));
    await upstream(request);

    expect(seenMethod).toBe("HEAD");
    expect(seenBody).toBeNull();
  });

  it("an already-consumed body is reported as this package's own 502, not a rejected promise", async () => {
    const upstream = urlUpstream({ base: `${fixture.origin}/echo` });

    const request = new Request("http://mesh.local/x", {
      method: "POST",
      body: "read by something else first",
    });
    await request.text(); // disturbs the body: `request.bodyUsed` is now true
    hideBody(request); // Firefox hides `body` for every request, consumed or not

    // Pre-fix, buffering ran OUTSIDE the try: `request.arrayBuffer()` on an
    // already-consumed body throws `TypeError: Body is unusable`, so this
    // call would have rejected instead of resolving to a Response — a new
    // failure mode introduced by the fix, in exactly the engine it targets.
    const res = await upstream(request);

    expect(res.status).toBe(502);
    expect(res.headers.get("x-webrun-proxy")).toBe("upstream-unreachable");
  });

  it("a real ReadableStream body still streams to the upstream — chunks arrive separately, not merged into one", async () => {
    // No hiding here: the untouched path a real Chromium/Node request takes.
    const upstream = urlUpstream({ base: `${fixture.origin}/request-stream` });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first-"));
        // Buffering would wait for the WHOLE input stream — at least this
        // delay — before opening the upstream connection at all, so nothing
        // would arrive at the fixture before it elapses. Streaming lets the
        // first chunk leave (and arrive) almost immediately.
        await new Promise((resolve) => setTimeout(resolve, 300));
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
    const { arrivals } = (await res.json()) as { arrivals: number[] };

    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    // The first byte arrives well before the 300ms gap has elapsed...
    expect(arrivals[0]).toBeLessThan(150);
    // ...and the last byte arrives only after it has, proving the two writes
    // were not merged into a single buffered send.
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThan(150);
  });
});
