/**
 * Direction 1: the reference implementation mints the token, ours reads it.
 *
 * Every token here was produced by the Rust `biscuit-auth` crate (compiled to
 * WASM). If our decoder, symbol resolution, signature check, engine or
 * authorizer differs from upstream in any observable way, one of these fails.
 */
import assert from "node:assert";
import { authorize, loadToken } from "../../src/authorizer.js";
import { CASES } from "./cases.js";
import {
  addCode,
  checksOf,
  loadReference,
  type Reference,
  referenceOutcome,
} from "./reference.js";

const ref: Reference | null = await loadReference();
const skipped: string[] = [];

const hexToBytes = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};

/** mint with the reference; returns null when it cannot express the case */
function mintWithReference(c: (typeof CASES)[number]) {
  const kp = new ref!.KeyPair(0); // Ed25519
  const builder = new ref!.BiscuitBuilder();
  addCode(ref!, builder, c.authority);
  let token = builder.build(kp.getPrivateKey());
  for (const code of c.blocks ?? []) {
    const block = new ref!.BlockBuilder();
    addCode(ref!, block, code);
    token = token.appendBlock(block);
  }
  if (c.seal) token = token.sealToken();
  return {
    bytes: new Uint8Array(token.toBytes()),
    rootKey: hexToBytes(
      kp
        .getPublicKey()
        .toString()
        .replace(/^ed25519\//, ""),
    ),
    token,
  };
}

for (const c of CASES) {
  test.skipIf(!ref)(`native → ts :: ${c.name}`, () => {
    let minted: ReturnType<typeof mintWithReference>;
    try {
      minted = mintWithReference(c);
    } catch (e) {
      if (c.feature) {
        skipped.push(c.name);
        return; // the pinned reference build predates this feature
      }
      throw e;
    }

    // our implementation must accept a token it has never seen before
    const loaded = loadToken(minted.bytes, minted.rootKey);
    assert.equal(loaded.blocks.length, 1 + (c.blocks?.length ?? 0), "block count");

    const result = authorize(loaded, c.authorizer);

    // the reference authorizes its own token, and we must reach the same verdict
    const ab = new ref!.AuthorizerBuilder();
    addCode(ref!, ab, c.authorizer);
    const theirResult = referenceOutcome(ab.buildAuthenticated(minted.token));

    assert.equal(
      result.kind,
      theirResult.kind,
      `${c.name}: differential mismatch — ours ${JSON.stringify(result)}, reference ${JSON.stringify(theirResult)}`,
    );
    if (result.kind === "ok" && theirResult.kind === "ok")
      assert.equal(result.policy, theirResult.policy, "matched policy index");
    assert.deepStrictEqual(checksOf(result), checksOf(theirResult), `${c.name}: failed checks`);
    assert.equal(
      result.kind,
      c.expect,
      `${c.name}: both implementations say ${result.kind}, case expected ${c.expect}`,
    );

    // revocation ids are derived from the signatures, so they must agree
    const theirs: string[] = minted.token.getRevocationIdentifiers();
    assert.deepStrictEqual(loaded.revocationIds, theirs, "revocation identifiers");
  });
}

test.skipIf(!ref)("a token from the reference fails against the wrong root key", () => {
  const minted = mintWithReference(CASES[0]);
  const wrong = new Uint8Array(minted.rootKey);
  wrong[0] ^= 0xff;
  assert.throws(() => loadToken(minted.bytes, wrong));
});

test.skipIf(!ref)("cross-reference coverage (native → ts)", () => {
  const ran = CASES.length - skipped.length;
  assert.ok(ran >= 15, `only ${ran} cases ran; skipped: ${skipped.join(", ")}`);
  if (skipped.length)
    console.log(`  note: reference v${ref!.version} could not express: ${skipped.join(", ")}`);
});
