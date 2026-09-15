import assert from "node:assert";
import fs from "node:fs";
import { revocationIds, verifyToken, verifyTokenAsync } from "../src/crypto.js";
import { decodeBiscuit } from "../src/proto.js";

const dir = new URL("../samples/", import.meta.url).pathname;
const samples = JSON.parse(fs.readFileSync(dir + "samples.json", "utf8"));
const rootKey = Buffer.from(samples.root_public_key, "hex");

// samples whose expected result is a Format/signature error
const EXPECT_FAIL = new Set([
  "test002_different_root_key.bc",
  "test003_invalid_signature_format.bc",
  "test004_random_block.bc",
  "test005_invalid_signature.bc",
  "test006_reordered_blocks.bc",
]);

test("signature chain verification matches expectations for all 38 samples", () => {
  let checked = 0;
  for (const tc of samples.testcases) {
    const raw = new Uint8Array(fs.readFileSync(dir + tc.filename));
    let ok: boolean;
    try {
      const tok = decodeBiscuit(raw);
      verifyToken(tok, rootKey);
      ok = true;
    } catch {
      ok = false;
    }
    assert.equal(ok, !EXPECT_FAIL.has(tc.filename), `${tc.filename} verification`);
    checked++;
  }
  assert.equal(checked, 38);
});

test("async verification (WebCrypto where available) agrees with sync on all 38 samples", async () => {
  let checked = 0;
  for (const tc of samples.testcases) {
    const raw = new Uint8Array(fs.readFileSync(dir + tc.filename));
    let ok: boolean;
    try {
      await verifyTokenAsync(decodeBiscuit(raw), rootKey);
      ok = true;
    } catch {
      ok = false;
    }
    assert.equal(ok, !EXPECT_FAIL.has(tc.filename), `${tc.filename} async verification`);
    checked++;
  }
  assert.equal(checked, 38);
});

test("revocation ids match the expected values", () => {
  for (const tc of samples.testcases) {
    if (EXPECT_FAIL.has(tc.filename)) continue; // ids are only produced for verified tokens
    const expected = (Object.values(tc.validations)[0] as any)?.revocation_ids;
    if (!expected) continue;
    const raw = new Uint8Array(fs.readFileSync(dir + tc.filename));
    let tok: ReturnType<typeof decodeBiscuit>;
    try {
      tok = decodeBiscuit(raw);
    } catch {
      continue;
    }
    const got = revocationIds(tok).map((b) => Buffer.from(b).toString("hex"));
    assert.deepStrictEqual(got, expected, tc.filename);
  }
});
