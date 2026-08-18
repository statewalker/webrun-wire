import { describe, expect, it } from "vitest";
import { ByteReader } from "../src/bytes.js";
import { HttpParseError } from "../src/http1/errors.js";
import {
  encodeHeaderLines,
  getAll,
  readHeaderSection,
  resolveFraming,
  withoutHeaders,
} from "../src/http1/headers.js";

const enc = (s: string) => new TextEncoder().encode(s);
const read = (wire: string, max = 65536) => readHeaderSection(new ByteReader([enc(wire)]), max, 0);

describe("readHeaderSection", () => {
  it("reads names and values verbatim, trimming only OWS", async () => {
    const headers = await read("Host: example.test\r\nX-Mixed-Case:   spaced   \r\n\r\n");
    expect(headers).toEqual([
      ["Host", "example.test"],
      ["X-Mixed-Case", "spaced"],
    ]);
  });

  it("keeps duplicate headers as separate entries", async () => {
    const headers = await read("Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n");
    expect(getAll(headers, "set-cookie")).toEqual(["a=1", "b=2"]);
  });

  it("accepts an empty value", async () => {
    expect(await read("X-Empty:\r\n\r\n")).toEqual([["X-Empty", ""]]);
  });

  it("rejects obs-fold continuation", async () => {
    await expect(read("X-A: one\r\n  two\r\n\r\n")).rejects.toThrow(/obs-fold/);
  });

  it("rejects a space in the header name", async () => {
    await expect(read("Bad Header: x\r\n\r\n")).rejects.toThrow(/invalid header name/);
  });

  it("rejects a head larger than the bound", async () => {
    const big = `X-Big: ${"a".repeat(200)}\r\n\r\n`;
    await expect(read(big, 64)).rejects.toThrow(HttpParseError);
  });
});

describe("encodeHeaderLines", () => {
  it("emits name: value CRLF pairs", () => {
    expect(
      encodeHeaderLines([
        ["A", "1"],
        ["b", "2"],
      ]),
    ).toBe("A: 1\r\nb: 2\r\n");
  });

  it("refuses a value containing CR or LF", () => {
    expect(() => encodeHeaderLines([["X", "a\r\nInjected: yes"]])).toThrow(/CR or LF/);
  });

  it("refuses an invalid name", () => {
    expect(() => encodeHeaderLines([["X Y", "1"]])).toThrow(/invalid header name/);
  });
});

describe("resolveFraming", () => {
  it("returns none when nothing is declared", () => {
    expect(resolveFraming([], "HTTP/1.1")).toEqual({ kind: "none" });
  });

  it("reads a Content-Length", () => {
    expect(resolveFraming([["Content-Length", "42"]], "HTTP/1.1")).toEqual({
      kind: "length",
      length: 42,
    });
  });

  it("reads chunked", () => {
    expect(resolveFraming([["Transfer-Encoding", "chunked"]], "HTTP/1.1")).toEqual({
      kind: "chunked",
    });
  });

  it("refuses Content-Length and Transfer-Encoding together", () => {
    expect(() =>
      resolveFraming(
        [
          ["Content-Length", "5"],
          ["Transfer-Encoding", "chunked"],
        ],
        "HTTP/1.1",
      ),
    ).toThrow(/smuggling/);
  });

  it("refuses conflicting duplicate Content-Length", () => {
    expect(() =>
      resolveFraming(
        [
          ["Content-Length", "5"],
          ["Content-Length", "6"],
        ],
        "HTTP/1.1",
      ),
    ).toThrow(/conflicting Content-Length/);
  });

  it("folds identical duplicate Content-Length", () => {
    expect(
      resolveFraming(
        [
          ["Content-Length", "5"],
          ["Content-Length", "5"],
        ],
        "HTTP/1.1",
      ),
    ).toEqual({
      kind: "length",
      length: 5,
    });
  });

  it("refuses a non-numeric Content-Length", () => {
    expect(() => resolveFraming([["Content-Length", "0x5"]], "HTTP/1.1")).toThrow(
      /invalid Content-Length/,
    );
  });

  it("refuses a Transfer-Encoding that is not chunked", () => {
    expect(() => resolveFraming([["Transfer-Encoding", "gzip"]], "HTTP/1.1")).toThrow(
      /unsupported Transfer-Encoding/,
    );
  });

  it("refuses chunked on HTTP/1.0", () => {
    expect(() => resolveFraming([["Transfer-Encoding", "chunked"]], "HTTP/1.0")).toThrow(
      /not valid in HTTP\/1\.0/,
    );
  });
});

describe("withoutHeaders", () => {
  it("drops case-insensitively", () => {
    expect(
      withoutHeaders(
        [
          ["Host", "a"],
          ["X", "b"],
        ],
        ["host"],
      ),
    ).toEqual([["X", "b"]]);
  });
});
