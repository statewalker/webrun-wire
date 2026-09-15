import assert from "node:assert";
import {
  Biscuit,
  evaluate,
  fromBase64,
  generateKeypair,
  SignatureError,
  toBase64,
} from "../src/index.js";

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

test("verifyAsync accepts what verify accepts, and refuses what it refuses", async () => {
  for (const algorithm of [0, 1] as const) {
    const root = generateKeypair(algorithm);
    const other = generateKeypair(algorithm);
    const plain = Biscuit.build(root.secretKey, 'user("alice");', { algorithm }).attenuate(
      'check if operation("read");',
      { algorithm },
    );
    for (const token of [plain, plain.seal()]) {
      const text = token.toBase64();
      const verified = await Biscuit.fromBase64(text).verifyAsync(root.publicKey, algorithm);
      assert.deepEqual(verified.revocationIds, Biscuit.fromBase64(text).verify(root.publicKey, algorithm).revocationIds);
      await assert.rejects(Biscuit.fromBase64(text).verifyAsync(other.publicKey, algorithm), SignatureError);
    }
  }
});

test("verifyAsync refuses a forged seal and a tampered block", async () => {
  const root = generateKeypair();
  const bytes = Biscuit.build(root.secretKey, 'user("alice");').seal().bytes;
  const forgedSeal = bytes.slice();
  forgedSeal[forgedSeal.length - 5] ^= 1;
  await assert.rejects(Biscuit.fromBytes(forgedSeal).verifyAsync(root.publicKey));
  assert.throws(() => Biscuit.fromBytes(forgedSeal).verify(root.publicKey));

  const unsealed = Biscuit.build(root.secretKey, 'user("alice");').attenuate("check if x(1);").bytes;
  for (let i = 40; i < unsealed.length; i += 17) {
    const tampered = unsealed.slice();
    tampered[i] ^= 0x10;
    let sync = true;
    let asyncOk = true;
    try {
      Biscuit.fromBytes(tampered).verify(root.publicKey);
    } catch {
      sync = false;
    }
    try {
      await Biscuit.fromBytes(tampered).verifyAsync(root.publicKey);
    } catch {
      asyncOk = false;
    }
    assert.equal(asyncOk, sync, `byte ${i}`);
  }
});

test("the facade binds parameters and evaluates with queries", () => {
  const root = generateKeypair();
  const verified = Biscuit.build(root.secretKey, "user({u});", { params: { u: "alice" } })
    .toBase64();
  const ev = Biscuit.fromBase64(verified)
    .verify(root.publicKey)
    .evaluate("operation({op});\nallow if user($u);", { params: { op: "read" } });
  assert.deepStrictEqual(ev.result, { kind: "ok", policy: 0 });
  assert.deepStrictEqual(ev.query("x($u) <- user($u)")[0].terms, [{ t: "str", v: "alice" }]);
  assert.deepStrictEqual(evaluate(null, "allow if true;").result, { kind: "ok", policy: 0 });
});
