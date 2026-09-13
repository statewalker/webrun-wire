/**
 * Direction 3: chains built by both implementations at once.
 *
 * A Biscuit is a chain of signatures, and attenuation is the operation most
 * likely to be performed by a different implementation than the one that
 * minted the token — a client attenuating a token it was issued. These tests
 * alternate who appends each block and check that the result still verifies on
 * both sides.
 */
import assert from "node:assert";
import { authorize, loadToken, parseAuthorizer } from "../../src/authorizer.js";
import { fromBase64, toBase64 } from "../../src/base64.js";
import { attenuate, buildToken, generateKeypair, sealToken } from "../../src/builder.js";
import { decodeBiscuit, decodeBlock } from "../../src/proto.js";
import { requiredVersion } from "../../src/version.js";
import { addCode, loadReference, type Reference, referenceOutcome } from "./reference.js";

const ref: Reference | null = await loadReference();
const noReference = !ref;
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
/** the reference's PublicKey.toBytes() is broken in this build; its toString()
 *  returns "<algorithm>/<hex>", which is the reliable way to get the key out */
const refPublicKey = (kp: any): Uint8Array => unhex(String(kp.getPublicKey()).split("/")[1]);

/** hand a token to the reference, attenuate there, hand it back as bytes */
function attenuateWithReference(
  bytes: Uint8Array,
  rootPublic: Uint8Array,
  code: string,
): Uint8Array {
  const key = ref!.PublicKey.fromString(hex(rootPublic), 0);
  const token = ref!.Biscuit.fromBase64(toBase64(bytes), key);
  const block = new ref!.BlockBuilder();
  addCode(ref!, block, code);
  return new Uint8Array(token.appendBlock(block).toBytes());
}

function authorizeWithReference(bytes: Uint8Array, rootPublic: Uint8Array, code: string) {
  const key = ref!.PublicKey.fromString(hex(rootPublic), 0);
  const token = ref!.Biscuit.fromBase64(toBase64(bytes), key);
  const ab = new ref!.AuthorizerBuilder();
  addCode(ref!, ab, code);
  return referenceOutcome(ab.buildAuthenticated(token));
}

test.skipIf(noReference)("we mint, the reference attenuates, we verify", () => {
  const root = generateKeypair();
  let bytes = buildToken(root.secretKey, 'user("alice");\nright("file1", "read");');
  bytes = attenuateWithReference(bytes, root.publicKey, 'check if operation("read");');

  const loaded = loadToken(bytes, root.publicKey);
  assert.equal(loaded.blocks.length, 2);
  assert.deepEqual(authorize(loaded, 'operation("read");\nallow if user("alice");'), {
    kind: "ok",
    policy: 0,
  });
  // the check the reference added must still bite
  assert.equal(
    authorize(loaded, 'operation("write");\nallow if user("alice");').kind,
    "unauthorized",
  );
});

test.skipIf(noReference)("the reference mints, we attenuate, the reference verifies", () => {
  const kp = new ref!.KeyPair(0);
  const builder = new ref!.BiscuitBuilder();
  addCode(ref!, builder, 'user("bob");\nright("file2", "write");');
  const minted = builder.build(kp.getPrivateKey());
  const rootPublic = refPublicKey(kp);

  const attenuated = attenuate(new Uint8Array(minted.toBytes()), 'check if operation("write");');

  const allowed = authorizeWithReference(
    attenuated,
    rootPublic,
    'operation("write");\nallow if user("bob");',
  );
  assert.equal(allowed.kind, "ok", JSON.stringify(allowed));

  const denied = authorizeWithReference(
    attenuated,
    rootPublic,
    'operation("read");\nallow if user("bob");',
  );
  assert.equal(denied.kind, "unauthorized", JSON.stringify(denied));
});

test.skipIf(noReference)("a chain with blocks appended alternately by both implementations", () => {
  const root = generateKeypair();
  let bytes = buildToken(
    root.secretKey,
    'user("carol");\nright("f", "read");\nright("f", "write");',
  );
  bytes = attenuateWithReference(bytes, root.publicKey, 'check if resource("f");');
  bytes = attenuate(bytes, 'check if operation("read");');
  bytes = attenuateWithReference(bytes, root.publicKey, 'check if client("mobile");');
  bytes = attenuate(bytes, "check if time($t), $t < 2999-01-01T00:00:00Z;");

  assert.equal(decodeBiscuit(bytes).blocks.length, 4);

  const authorizer =
    'resource("f");\noperation("read");\nclient("mobile");\ntime(2026-01-01T00:00:00Z);\nallow if user("carol");';
  const ours = authorize(loadToken(bytes, root.publicKey), authorizer);
  const theirs = authorizeWithReference(bytes, root.publicKey, authorizer);
  assert.equal(ours.kind, "ok", JSON.stringify(ours));
  assert.equal(theirs.kind, "ok", JSON.stringify(theirs));

  // every one of the four checks must still be enforced
  for (const missing of ['resource("f")', 'operation("read")', 'client("mobile")']) {
    const weakened = authorizer.replace(`${missing};\n`, "");
    assert.equal(
      authorize(loadToken(bytes, root.publicKey), weakened).kind,
      "unauthorized",
      missing,
    );
    assert.notEqual(authorizeWithReference(bytes, root.publicKey, weakened).kind, "ok", missing);
  }
});

test.skipIf(noReference)("sealing is honoured across implementations", () => {
  const root = generateKeypair();
  const sealed = sealToken(buildToken(root.secretKey, 'user("dave");'));

  // the reference still verifies and authorizes it
  const outcome = authorizeWithReference(sealed, root.publicKey, 'allow if user("dave");');
  assert.equal(outcome.kind, "ok", JSON.stringify(outcome));

  // but neither side may append to it
  assert.throws(() => attenuate(sealed, "check if true;"), /sealed/);
  assert.throws(() => attenuateWithReference(sealed, root.publicKey, "check if true;"));
});

test.skipIf(noReference)("a token sealed by the reference cannot be attenuated by us", () => {
  const kp = new ref!.KeyPair(0);
  const builder = new ref!.BiscuitBuilder();
  addCode(ref!, builder, 'user("erin");');
  const sealed = builder.build(kp.getPrivateKey()).sealToken();
  const bytes = new Uint8Array(sealed.toBytes());

  assert.doesNotThrow(() => loadToken(bytes, refPublicKey(kp)));
  assert.throws(() => attenuate(bytes, "check if true;"), /sealed/);
});

test.skipIf(noReference)("base64 text round-trips between the implementations", () => {
  const root = generateKeypair();
  const bytes = buildToken(root.secretKey, 'user("frank");');
  const ourText = toBase64(bytes);

  const key = ref!.PublicKey.fromString(hex(root.publicKey), 0);
  const theirToken = ref!.Biscuit.fromBase64(ourText, key);
  const theirText = theirToken.toBase64();

  // the reference may pad; the bytes underneath must be identical
  assert.deepStrictEqual(fromBase64(theirText), bytes, "same bytes after their re-encoding");
  assert.doesNotThrow(() => loadToken(fromBase64(theirText), root.publicKey));
});

test.skipIf(noReference)("we and the reference stamp the same Datalog version on a block", () => {
  // block content -> the version the reference writes into the wire format
  const cases: [string, string][] = [
    ["plain facts", 'user("x");'],
    ["arrays", "scores([1, 2, 3]);"],
    ["maps", 'meta({"k": "v"});'],
    ["null", "missing(null);"],
    ["scopes", "check if user($u) trusting authority;"],
    ["check all", 'check all user($u), $u.starts_with("x");'],
    ["reject if", 'reject if banned("x");'],
  ];

  for (const [label, code] of cases) {
    const kp = new ref!.KeyPair(0);
    const builder = new ref!.BiscuitBuilder();
    addCode(ref!, builder, code);
    const theirVersion = decodeBlock(
      decodeBiscuit(new Uint8Array(builder.build(kp.getPrivateKey()).toBytes())).authority.block,
    ).version;

    const parsed = parseAuthorizer(code);
    const ourVersion = requiredVersion({
      facts: parsed.facts,
      rules: parsed.rules,
      checks: parsed.checks,
      scopes: parsed.scopes,
    });

    assert.equal(
      ourVersion,
      theirVersion,
      `${label}: we say v${ourVersion}, reference writes v${theirVersion}`,
    );
  }
});
