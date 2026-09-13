/**
 * Direction 4: randomized differential testing.
 *
 * The hand-written cases in `cases.ts` only find the bugs someone thought to
 * look for. Here the programs are generated, and the *oracle is the other
 * implementation*: for each random token we assert that we and the reference
 * reach the same verdict. Nothing is hard-coded about what the answer should
 * be, so a disagreement is a genuine finding either way.
 *
 * Both signature algorithms are exercised across the boundary — Ed25519 and
 * secp256r1 — in both directions.
 */
import assert from "node:assert";
import { authorize, loadToken } from "../../src/authorizer.js";
import { toBase64 } from "../../src/base64.js";
import { attenuate, buildToken, generateKeypair, sealToken } from "../../src/builder.js";
import { describeProgram, type Program, randomProgram, rng } from "./generator.js";
import { addCode, loadReference, type Reference, referenceOutcome } from "./reference.js";

const ref: Reference | null = await loadReference();
const noReference = !ref;

const ALGORITHMS: { name: string; id: 0 | 1 }[] = [
  { name: "Ed25519", id: 0 },
  { name: "secp256r1", id: 1 },
];

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
/** the reference's PublicKey.toBytes() is broken; toString() gives "<alg>/<hex>" */
const refPublicKey = (kp: any): Uint8Array => unhex(String(kp.getPublicKey()).split("/")[1]);

/* ------------------------------------------------------------- minting */

function mintWithReference(p: Program, algorithm: 0 | 1) {
  const kp = new ref!.KeyPair(algorithm);
  const builder = new ref!.BiscuitBuilder();
  addCode(ref!, builder, p.authority);
  let token = builder.build(kp.getPrivateKey());
  for (const code of p.blocks) {
    const block = new ref!.BlockBuilder();
    addCode(ref!, block, code);
    token = token.appendBlock(block);
  }
  if (p.seal) token = token.sealToken();
  return { token, bytes: new Uint8Array(token.toBytes()), rootPublic: refPublicKey(kp) };
}

function mintWithUs(p: Program, algorithm: 0 | 1) {
  const root = generateKeypair(algorithm);
  let bytes = buildToken(root.secretKey, p.authority, { algorithm });
  for (const code of p.blocks) bytes = attenuate(bytes, code, { algorithm });
  if (p.seal) bytes = sealToken(bytes);
  return { bytes, root };
}

function authorizeWithReference(
  bytes: Uint8Array,
  rootPublic: Uint8Array,
  algorithm: 0 | 1,
  code: string,
) {
  const key = ref!.PublicKey.fromString(hex(rootPublic), algorithm);
  const token = ref!.Biscuit.fromBase64(toBase64(bytes), key);
  const ab = new ref!.AuthorizerBuilder();
  addCode(ref!, ab, code);
  return referenceOutcome(ab.buildAuthenticated(token));
}

/* --------------------------------------------------------------- tests */

/** seeds per direction per algorithm; the suite runs 4x this many programs,
 *  plus the mixed-chain rounds. Kept modest so `pnpm test:cross` stays quick —
 *  sweeps of several thousand are for deliberate campaigns, by raising this. */
const ROUNDS = 75;

for (const algorithm of ALGORITHMS) {
  test.skipIf(noReference)(
    `random differential :: reference mints, we authorize (${algorithm.name})`,
    () => {
      for (let seed = 1; seed <= ROUNDS; seed++) {
        const r = rng(seed * 7919 + algorithm.id);
        const program = randomProgram(r);
        const { token, bytes, rootPublic } = mintWithReference(program, algorithm.id);

        const ours = authorize(loadToken(bytes, rootPublic, algorithm.id), program.authorizer);

        const ab = new ref!.AuthorizerBuilder();
        addCode(ref!, ab, program.authorizer);
        const theirs = referenceOutcome(ab.buildAuthenticated(token));

        assert.equal(
          ours.kind,
          theirs.kind,
          `verdict mismatch — ours ${JSON.stringify(ours)}, reference ${JSON.stringify(theirs)}\n${describeProgram(program, seed, algorithm.name)}`,
        );
        if (ours.kind === "ok" && theirs.kind === "ok")
          assert.equal(
            ours.policy,
            theirs.policy,
            `policy index\n${describeProgram(program, seed, algorithm.name)}`,
          );

        assert.deepStrictEqual(
          loadToken(bytes, rootPublic, algorithm.id).revocationIds,
          token.getRevocationIdentifiers(),
          `revocation ids\n${describeProgram(program, seed, algorithm.name)}`,
        );
      }
    },
  );

  test.skipIf(noReference)(
    `random differential :: we mint, reference authorizes (${algorithm.name})`,
    () => {
      for (let seed = 1; seed <= ROUNDS; seed++) {
        const r = rng(seed * 104729 + algorithm.id);
        const program = randomProgram(r);
        const { bytes, root } = mintWithUs(program, algorithm.id);

        const ours = authorize(loadToken(bytes, root.publicKey, algorithm.id), program.authorizer);
        const theirs = authorizeWithReference(
          bytes,
          root.publicKey,
          algorithm.id,
          program.authorizer,
        );

        assert.equal(
          ours.kind,
          theirs.kind,
          `verdict mismatch — ours ${JSON.stringify(ours)}, reference ${JSON.stringify(theirs)}\n${describeProgram(program, seed, algorithm.name)}`,
        );
        if (ours.kind === "ok" && theirs.kind === "ok")
          assert.equal(
            ours.policy,
            theirs.policy,
            `policy index\n${describeProgram(program, seed, algorithm.name)}`,
          );
      }
    },
  );

  test.skipIf(noReference)(
    `random differential :: mixed attenuation chains (${algorithm.name})`,
    () => {
      for (let seed = 1; seed <= 20; seed++) {
        const r = rng(seed * 15485863 + algorithm.id);
        const program = randomProgram(r);
        const { bytes, root } = mintWithUs({ ...program, blocks: [], seal: false }, algorithm.id);

        // alternate: we append the even-numbered blocks, the reference the odd ones
        let chain = bytes;
        program.blocks.forEach((code, i) => {
          if (i % 2 === 0) {
            chain = attenuate(chain, code, { algorithm: algorithm.id });
          } else {
            const key = ref!.PublicKey.fromString(hex(root.publicKey), algorithm.id);
            const token = ref!.Biscuit.fromBase64(toBase64(chain), key);
            const block = new ref!.BlockBuilder();
            addCode(ref!, block, code);
            chain = new Uint8Array(token.appendBlock(block).toBytes());
          }
        });

        const ours = authorize(loadToken(chain, root.publicKey, algorithm.id), program.authorizer);
        const theirs = authorizeWithReference(
          chain,
          root.publicKey,
          algorithm.id,
          program.authorizer,
        );
        assert.equal(
          ours.kind,
          theirs.kind,
          `verdict mismatch on a mixed chain — ours ${JSON.stringify(ours)}, reference ${JSON.stringify(theirs)}\n${describeProgram(program, seed, algorithm.name)}`,
        );
      }
    },
  );
}

test.skipIf(noReference)("the generator produces a spread of outcomes, not just one", () => {
  const seen = new Map<string, number>();
  for (let seed = 1; seed <= ROUNDS; seed++) {
    const program = randomProgram(rng(seed * 7919));
    const { bytes, root } = mintWithUs(program, 0);
    const kind = authorize(loadToken(bytes, root.publicKey), program.authorizer).kind;
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
  }
  // A generator that only ever produced `noMatchingPolicy` would pass every
  // differential assertion while exercising almost nothing. Injected-bug runs
  // showed this is not hypothetical: before the generator emitted several
  // `resource` facts, `check all` had a single combination to quantify over,
  // so breaking `all` into `any` changed no verdict anywhere.
  assert.ok((seen.get("ok") ?? 0) >= 10, `too few authorized: ${JSON.stringify([...seen])}`);
  assert.ok((seen.get("unauthorized") ?? 0) >= 5, `too few denied: ${JSON.stringify([...seen])}`);
  assert.ok(seen.size >= 3, `outcome kinds too narrow: ${JSON.stringify([...seen])}`);
});
