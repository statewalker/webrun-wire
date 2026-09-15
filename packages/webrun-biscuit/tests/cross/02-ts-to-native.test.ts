/**
 * Direction 2: we mint the token, the reference implementation reads it.
 *
 * This is the direction that matters for interoperability in production: a
 * token we issue has to be accepted by every other Biscuit implementation, all
 * of which descend from this Rust code.
 */
import assert from "node:assert";
import { toBase64 } from "../../src/base64.js";
import { attenuate, buildToken, generateKeypair, sealToken } from "../../src/builder.js";
import { CASES } from "./cases.js";
import { addCode, loadReference, type Reference, referenceOutcome } from "./reference.js";

const ref: Reference | null = await loadReference();
const skipped: string[] = [];
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** mint entirely with our implementation */
function mintWithUs(c: (typeof CASES)[number]) {
  const root = generateKeypair();
  let bytes = buildToken(root.secretKey, c.authority);
  for (const code of c.blocks ?? []) bytes = attenuate(bytes, code);
  if (c.seal) bytes = sealToken(bytes);
  return { bytes, root };
}

for (const c of CASES) {
  test.skipIf(!ref)(`ts → native :: ${c.name}`, () => {
    const { bytes, root } = mintWithUs(c);

    // the reference must accept our bytes and our signature chain
    const publicKey = ref!.PublicKey.fromString(hex(root.publicKey), 0);
    let token: any;
    try {
      token = ref!.Biscuit.fromBase64(toBase64(bytes), publicKey);
    } catch (e) {
      if (c.feature) {
        skipped.push(c.name);
        return; // the pinned reference build predates this Datalog version
      }
      throw new Error(`${c.name}: reference rejected our token: ${JSON.stringify(e)}`);
    }

    assert.equal(token.countBlocks(), 1 + (c.blocks?.length ?? 0), "block count");

    const ab = new ref!.AuthorizerBuilder();
    try {
      addCode(ref!, ab, c.authorizer);
    } catch (e) {
      if (c.feature) {
        skipped.push(c.name);
        return;
      }
      throw e;
    }
    const outcome = referenceOutcome(ab.buildAuthenticated(token));
    assert.equal(outcome.kind, c.expect, `${c.name}: reference said ${JSON.stringify(outcome)}`);
  });
}

test.skipIf(!ref)("the reference rejects our token under the wrong root key", () => {
  const { bytes, root } = mintWithUs(CASES[0]);
  const wrong = new Uint8Array(root.publicKey);
  wrong[0] ^= 0xff;
  assert.throws(() =>
    ref!.Biscuit.fromBase64(toBase64(bytes), ref!.PublicKey.fromString(hex(wrong), 0)),
  );
});

test.skipIf(!ref)("the reference rejects a token we minted and then tampered with", () => {
  const { bytes, root } = mintWithUs(CASES[0]);
  const tampered = bytes.slice();
  tampered[tampered.length - 10] ^= 0x01;
  assert.throws(() =>
    ref!.Biscuit.fromBase64(toBase64(tampered), ref!.PublicKey.fromString(hex(root.publicKey), 0)),
  );
});

test.skipIf(!ref)("cross-reference coverage (ts → native)", () => {
  const ran = CASES.length - skipped.length;
  assert.ok(ran >= 15, `only ${ran} cases ran; skipped: ${skipped.join(", ")}`);
  if (skipped.length)
    console.log(`  note: reference v${ref!.version} could not read: ${skipped.join(", ")}`);
});

test.skipIf(!ref)("ts → native :: the reference reads our variable names as written", () => {
  const root = generateKeypair();
  const bytes = buildToken(root.secretKey, "f(1);\ncheck if f($k), f($subject);");
  const token = ref!.Biscuit.fromBase64(toBase64(bytes), ref!.PublicKey.fromString(hex(root.publicKey), 0));
  assert.match(String(token.toString()), /check if f\(\$k\), f\(\$subject\)/);
});
