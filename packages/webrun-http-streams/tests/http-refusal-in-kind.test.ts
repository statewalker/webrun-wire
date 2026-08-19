import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { httpServe } from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const ok = async () => ({ envelope: { status: 200, statusText: "OK", headers: [] }, body: [] });
async function wire(input: string): Promise<string> {
  const serve: Duplex = httpServe(ok);
  let out = "";
  const d = new TextDecoder();
  for await (const c of serve([enc(input)])) out += d.decode(c, { stream: true });
  return out + d.decode();
}
// The 400 path converts HttpParseError only. The default codec accepts two
// formats, so BOTH must raise that type or half of it answers with silence —
// jsonEnvelopeCodec's decodeMessage previously threw a plain Error. And having
// answered, it must answer in the format the peer was speaking.
describe("400 answers in the peer's own format", () => {
  it("JSON-envelope peer gets a JSON envelope back", async () => {
    const out = await wire("{not json}\n");
    expect(out.startsWith("{")).toBe(true);
    expect(JSON.parse(out.split("\n")[0]).status).toBe(400);
  });
  it("HTTP peer still gets HTTP", async () => {
    expect(await wire("GET /x HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n")).toMatch(/^HTTP\/1\.1 400 /);
  });
  it("envelope flood is refused, not buffered", async () => {
    const serve: Duplex = httpServe(ok);
    async function* flood() {
      yield enc("{");
      for (let i = 0; i < 300; i++) yield new Uint8Array(1024 * 1024).fill(0x61);
    }
    let out = "";
    const d = new TextDecoder();
    for await (const c of serve(flood())) out += d.decode(c, { stream: true });
    expect(out).toContain("exceeds 65536 bytes");
  });
});
