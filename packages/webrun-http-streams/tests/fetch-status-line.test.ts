import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { fetchOverDuplex } from "../src/fetch.js";
import { HttpParseError } from "../src/index.js";

/**
 * A peer controls the status line. Whatever it sends, `fetchOverDuplex` rejects with an
 * `HttpParseError` (never the `RangeError` / `TypeError` of `new Response`) and ends the call,
 * even when the body that follows never ends by itself (#134).
 */

const enc = (s: string) => new TextEncoder().encode(s);

/** A call answering `head`, then an endless body; counts calls whose generator is still open. */
function peer(head: string, endless = true): { call: Duplex; open(): number } {
  let open = 0;
  const call: Duplex = () =>
    (async function* () {
      open++;
      try {
        yield enc(head);
        while (endless) {
          yield new Uint8Array(1024).fill(7);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      } finally {
        open--;
      }
    })();
  return { call, open: () => open };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const get = () => new Request("http://x/");

describe("fetchOverDuplex on a hostile status line (#134)", () => {
  for (const [name, head] of [
    ["status 600", "HTTP/1.1 600 X\r\n\r\n"],
    ["status 099", "HTTP/1.1 099 X\r\n\r\n"],
    ["status 101 (protocol switch)", "HTTP/1.1 101 Switching Protocols\r\nupgrade: x\r\n\r\n"],
    ["a control character in the reason phrase", "HTTP/1.1 200 O\x01K\r\n\r\n"],
    ["a DEL in the reason phrase", "HTTP/1.1 200 O\x7fK\r\n\r\n"],
    ["a 1xx then garbage", "HTTP/1.1 100 Continue\r\n\r\nnot http\r\n\r\n"],
    ["a JSON envelope with status 600", '{"status":600,"statusText":"X","headers":[]}\n'],
    ["a JSON envelope with status 99", '{"status":99,"statusText":"X","headers":[]}\n'],
    [
      "a JSON envelope with a bad statusText",
      '{"status":200,"statusText":"O\\u0001K","headers":[]}\n',
    ],
  ] as const) {
    it(`${name}: rejects with HttpParseError and ends the call`, async () => {
      const p = peer(head);
      const err = await fetchOverDuplex(p.call, get()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpParseError);
      await settle();
      expect(p.open()).toBe(0);
    });
  }

  it("leaves no abort listener on the request's signal", async () => {
    const p = peer('{"status":600,"statusText":"X","headers":[]}\n');
    const request = new Request("http://x/", { signal: new AbortController().signal });
    let listening = 0;
    const signal = request.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, ...rest: [EventListener]) => {
      if (type === "abort") listening++;
      add(type, ...rest);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, ...rest: [EventListener]) => {
      if (type === "abort") listening--;
      remove(type, ...rest);
    }) as typeof signal.removeEventListener;
    await expect(fetchOverDuplex(p.call, request)).rejects.toBeInstanceOf(HttpParseError);
    await settle();
    expect([listening, p.open()]).toEqual([0, 0]);
  });

  it("skips a 100 Continue and returns the final response", async () => {
    const p = peer(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nlink: </a>\r\n\r\n" +
        "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi",
      false,
    );
    const res = await fetchOverDuplex(p.call, get());
    expect(res.status).toBe(200);
    expect(res.headers.get("link")).toBeNull();
    expect(await res.text()).toBe("hi");
    await settle();
    expect(p.open()).toBe(0);
  });

  it("accepts obs-text and tabs in the reason phrase", async () => {
    const head = "HTTP/1.1 200 \xe9t\xe9\tok\r\ncontent-length: 0\r\n\r\n";
    const bytes = Uint8Array.from(head, (c) => c.charCodeAt(0)); // Latin-1, not UTF-8
    const call: Duplex = () =>
      (async function* () {
        yield bytes;
      })();
    const res = await fetchOverDuplex(call, get());
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("\xe9t\xe9\tok");
  });
});
