import assert from "node:assert";
import { Biscuit, fromBase64, generateKeypair, toBase64 } from "../src/index.js";

test("base64url round-trips arbitrary bytes", () => {
  for (const len of [0, 1, 2, 3, 4, 17, 64, 255]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
    assert.deepStrictEqual(fromBase64(toBase64(bytes)), bytes, `length ${len}`);
  }
  assert.ok(!toBase64(new Uint8Array([1, 2, 3, 4])).includes("="), "no padding");
  assert.ok(!/[+/]/.test(toBase64(new Uint8Array(64).fill(251))), "url-safe alphabet");
});

test("base64url accepts padded and standard-alphabet input", () => {
  assert.deepStrictEqual(fromBase64("AQID"), new Uint8Array([1, 2, 3]));
  assert.deepStrictEqual(fromBase64("AQIDBA=="), new Uint8Array([1, 2, 3, 4]));
  assert.throws(() => fromBase64("not base64!"), /invalid base64/);
});

test("the facade covers the full lifecycle", () => {
  const root = generateKeypair();
  const text = Biscuit.build(root.secretKey, 'user("alice");\nright("file1", "read");')
    .attenuate('check if operation("read");')
    .seal()
    .toBase64();

  assert.ok(text.length > 100 && !/[+/=]/.test(text));

  const verified = Biscuit.fromBase64(text).verify(root.publicKey);
  assert.equal(verified.revocationIds.length, 2);
  assert.deepEqual(verified.authorize('operation("read");\nallow if user("alice");'), {
    kind: "ok",
    policy: 0,
  });
  assert.equal(
    verified.authorize('operation("write");\nallow if user("alice");').kind,
    "unauthorized",
  );
});

test("verification rejects a token from a different root", () => {
  const root = generateKeypair();
  const other = generateKeypair();
  const text = Biscuit.build(root.secretKey, 'user("alice");').toBase64();
  assert.throws(() => Biscuit.fromBase64(text).verify(other.publicKey));
});
