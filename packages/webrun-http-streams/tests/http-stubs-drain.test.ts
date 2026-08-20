import { describe, expect, it } from "vitest";
import {
  newHttpClientStub,
  newHttpServerStub,
  type SerializedHttpEnvelope,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from "../src/http-stubs.js";

/**
 * Both stubs have a path that receives a body they are contractually forbidden
 * to read — a GET/HEAD/OPTIONS request, or a null-body-status response — and
 * must release its producer instead. They used to do that with a bare
 * `.return()`, which is a no-op on an async generator still in *suspended
 * start*: the body never runs, its `try/finally` never unwinds, and whatever
 * the producer holds open is never released. `bytes.ts`'s `discard` calls
 * `.next()` first for exactly this reason.
 *
 * Every producer here is a generator that has never been pulled from, which is
 * what a transport hands over, and each records in its `finally` whether it was
 * genuinely unwound. Asserting `cleanedUp` — not merely that no body reached
 * the handler — is the point: the leak is invisible from the outside.
 */

const encoder = new TextEncoder();

/** A body whose producer holds a resource, and says whether it was released. */
function heldOpen(): { content: AsyncGenerator<Uint8Array>; cleanedUp: () => boolean } {
  let cleanedUp = false;
  async function* content(): AsyncGenerator<Uint8Array> {
    try {
      yield encoder.encode("never read");
    } finally {
      cleanedUp = true;
    }
  }
  return { content: content(), cleanedUp: () => cleanedUp };
}

describe("http-stubs — releasing a body that must not be read", () => {
  describe("newHttpServerStub", () => {
    it.each([
      "GET",
      "HEAD",
      "OPTIONS",
    ])("unwinds the request producer for %s, which carries no body", async (method) => {
      const { content, cleanedUp } = heldOpen();
      const stub = newHttpServerStub(async (request) => {
        expect(request.body).toBeNull();
        return new Response("ok");
      });

      const envelope: SerializedHttpEnvelope<SerializedHttpRequest> = {
        options: { url: "http://peer/a", method, headers: [] },
        content,
      };
      await stub(envelope);

      expect(cleanedUp()).toBe(true);
    });

    it("does not touch the producer when the method does carry a body", async () => {
      // The mirror of the above: a POST body belongs to the handler, and
      // draining it here would consume the very bytes it is meant to read.
      const { content, cleanedUp } = heldOpen();
      let seen: string | undefined;
      const stub = newHttpServerStub(async (request) => {
        seen = await request.text();
        return new Response("ok");
      });

      await stub({ options: { url: "http://peer/a", method: "POST", headers: [] }, content });

      expect(seen).toBe("never read");
      // Consumed to completion by the handler rather than discarded, but either
      // way the `finally` ran.
      expect(cleanedUp()).toBe(true);
    });
  });

  describe("newHttpClientStub", () => {
    it.each([
      204, 205, 304,
    ])("unwinds the response producer for a %d, which carries no body", async (status) => {
      const { content, cleanedUp } = heldOpen();
      const stub = newHttpClientStub(
        async (): Promise<SerializedHttpEnvelope<SerializedHttpResponse>> => ({
          options: { status, statusText: "", headers: {} },
          content,
        }),
      );

      const response = await stub(new Request("http://peer/a"));

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(cleanedUp()).toBe(true);
    });

    it.each([
      "HEAD",
      "OPTIONS",
    ])("unwinds the response producer for %s, whatever the status", async (method) => {
      const { content, cleanedUp } = heldOpen();
      const stub = newHttpClientStub(
        async (): Promise<SerializedHttpEnvelope<SerializedHttpResponse>> => ({
          options: { status: 200, statusText: "OK", headers: {} },
          content,
        }),
      );

      const response = await stub(new Request("http://peer/a", { method }));

      expect(response.body).toBeNull();
      expect(cleanedUp()).toBe(true);
    });
  });
});
