import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { decodeBiscuit, decodeBlock, encodeBiscuit, encodeBlock } from "../src/proto.js";

const dir = new URL("../samples/", import.meta.url).pathname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".bc"))
  .sort();
// these two samples are deliberately corrupted and are not valid protobuf
const CORRUPT = new Set(["test003_invalid_signature_format.bc", "test004_random_block.bc"]);

test("every sample token round-trips byte-exactly", () => {
  let n = 0;
  for (const f of files) {
    const raw = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const tok = decodeBiscuit(raw);
    assert.deepStrictEqual(encodeBiscuit(tok), raw, `token ${f}`);
    n++;
  }
  assert.equal(n, 38);
});

test("every block round-trips byte-exactly", () => {
  for (const f of files) {
    if (CORRUPT.has(f)) continue;
    const raw = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const tok = decodeBiscuit(raw);
    const signed = [tok.authority, ...tok.blocks];
    for (const [i, sb] of signed.entries()) {
      const blk = decodeBlock(sb.block);
      assert.deepStrictEqual(encodeBlock(blk), sb.block, `${f} block ${i}`);
    }
  }
});

test("i64 extremes survive decoding", () => {
  const raw = new Uint8Array(fs.readFileSync(path.join(dir, "test027_integer_wraparound.bc")));
  const tok = decodeBiscuit(raw);
  const blk = decodeBlock(tok.authority.block);
  const ints: bigint[] = [];
  for (const c of blk.checks)
    for (const q of c.queries)
      for (const e of q.expressions)
        for (const op of e)
          if (op.kind === "value" && op.value.kind === "integer") ints.push(op.value.value);
  assert.ok(ints.includes(9223372036854775807n), "i64::MAX preserved");
  assert.ok(ints.includes(-9223372036854775808n), "i64::MIN preserved");
});

test("strict decoding rejects malformed input", () => {
  assert.throws(() => decodeBiscuit(new Uint8Array([0xff, 0xff, 0xff])));
  assert.throws(() => decodeBiscuit(new Uint8Array(0)), /authority/);
});
