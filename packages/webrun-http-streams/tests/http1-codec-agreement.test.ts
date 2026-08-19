import { describe, expect, it } from "vitest";
import {
  encodeRequest,
  encodeResponse,
  type ResolvedHttpCodecOptions,
} from "../src/http1/encode.js";
import { isBodylessStatus, resolveFraming } from "../src/http1/headers.js";

// The encoder and decoder each interpret Content-Length and the bodyless
// statuses. They once did so with separate copies of the same rules, which
// drifted: decode folded a comma list like "5, 5" while encode rejected it, so
// a relay that decoded then re-encoded threw. These pin the agreement.

const OPTS: ResolvedHttpCodecOptions = { scheme: "http", host: "h.test", maxHeaderBytes: 65536 };
const enc = (s: string) => new TextEncoder().encode(s);

async function wire(gen: AsyncGenerator<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of gen) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("encode and decode agree on Content-Length", () => {
  it("both fold an identical comma list", async () => {
    expect(resolveFraming([["Content-Length", "5, 5"]], "HTTP/1.1")).toEqual({
      kind: "length",
      length: 5,
    });
    const out = await wire(
      encodeRequest(
        { url: "http://h.test/x", method: "POST", headers: [["Content-Length", "5, 5"]] },
        [enc("hello")],
        OPTS,
      ),
    );
    expect(out.endsWith("\r\n\r\nhello")).toBe(true);
  });

  it("both refuse a conflicting comma list", async () => {
    expect(() => resolveFraming([["Content-Length", "5, 6"]], "HTTP/1.1")).toThrow(
      /conflicting Content-Length/,
    );
    await expect(
      wire(
        encodeRequest(
          { url: "http://h.test/x", method: "POST", headers: [["Content-Length", "5, 6"]] },
          [enc("hello")],
          OPTS,
        ),
      ),
    ).rejects.toThrow(/conflicting Content-Length/);
  });

  it("both refuse a non-numeric value", async () => {
    expect(() => resolveFraming([["Content-Length", "abc"]], "HTTP/1.1")).toThrow(
      /invalid Content-Length/,
    );
    await expect(
      wire(
        encodeRequest(
          { url: "http://h.test/x", method: "POST", headers: [["Content-Length", "abc"]] },
          [enc("x")],
          OPTS,
        ),
      ),
    ).rejects.toThrow(/invalid Content-Length/);
  });
});

describe("encode and decode agree on bodyless statuses", () => {
  it.each([[100], [101], [199], [204], [304]])("%i carries no body either way", async (status) => {
    expect(isBodylessStatus(status)).toBe(true);
    const out = await wire(
      encodeResponse({ status, statusText: "S", headers: [] }, [enc("body")], OPTS),
    );
    expect(out).not.toContain("body");
    expect(out).not.toMatch(/Transfer-Encoding/i);
  });

  it.each([[200], [201], [301], [400], [500]])("%i may carry a body either way", (status) => {
    expect(isBodylessStatus(status)).toBe(false);
  });
});
