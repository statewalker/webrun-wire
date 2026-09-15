/**
 * Biscuit cryptography: chained block signatures, sealing, third-party
 * (external) signatures. Ed25519 and ECDSA/secp256r1, per SPECIFICATIONS.md.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { fromBase64 } from "./base64.js";
import type { BiscuitMsg, PublicKeyMsg, SignedBlock } from "./proto.js";

export class SignatureError extends Error {}

const ALG_ED25519 = 0;
const ALG_SECP256R1 = 1;

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** little-endian i32, as used for algorithm ids and payload versions */
function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

function verifySignature(key: PublicKeyMsg, payload: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (key.algorithm === ALG_ED25519) return ed25519.verify(sig, payload, key.key);
    if (key.algorithm === ALG_SECP256R1) {
      // SEC1 DER (r, s) over SHA-256
      // noble hashes the payload itself with `prehash`; biscuit/RustCrypto do
      // not enforce low-S on verification, so malleable signatures are accepted
      return p256.verify(sig, payload, key.key, { format: "der", prehash: true, lowS: false });
    }
    return false;
  } catch {
    return false;
  }
}

export function publicKeyFromSecret(secret: Uint8Array, algorithm: number): Uint8Array {
  if (algorithm === ALG_ED25519) return ed25519.getPublicKey(secret);
  if (algorithm === ALG_SECP256R1) return p256.getPublicKey(secret, true);
  throw new SignatureError(`unknown algorithm ${algorithm}`);
}

/* ------------------------------------------------------- signature payloads */

export function blockPayloadV0(
  data: Uint8Array,
  nextKey: PublicKeyMsg,
  externalSig?: Uint8Array,
): Uint8Array {
  return concat(data, externalSig ?? new Uint8Array(0), le32(nextKey.algorithm), nextKey.key);
}

export function authorityPayloadV1(
  data: Uint8Array,
  nextKey: PublicKeyMsg,
  version: number,
): Uint8Array {
  return concat(
    ascii("\0BLOCK\0\0VERSION\0"),
    le32(version),
    ascii("\0PAYLOAD\0"),
    data,
    ascii("\0ALGORITHM\0"),
    le32(nextKey.algorithm),
    ascii("\0NEXTKEY\0"),
    nextKey.key,
  );
}

export function blockPayloadV1(
  data: Uint8Array,
  nextKey: PublicKeyMsg,
  externalSig: Uint8Array | undefined,
  previousSignature: Uint8Array,
  version: number,
): Uint8Array {
  return concat(
    ascii("\0BLOCK\0\0VERSION\0"),
    le32(version),
    ascii("\0PAYLOAD\0"),
    data,
    ascii("\0ALGORITHM\0"),
    le32(nextKey.algorithm),
    ascii("\0NEXTKEY\0"),
    nextKey.key,
    ascii("\0PREVSIG\0"),
    previousSignature,
    ...(externalSig ? [ascii("\0EXTERNALSIG\0"), externalSig] : []),
  );
}

export function externalPayloadV1(
  data: Uint8Array,
  previousSignature: Uint8Array,
  version: number,
): Uint8Array {
  return concat(
    ascii("\0EXTERNAL\0\0VERSION\0"),
    le32(version),
    ascii("\0PAYLOAD\0"),
    data,
    ascii("\0PREVSIG\0"),
    previousSignature,
  );
}

export function sealPayloadV0(block: SignedBlock): Uint8Array {
  return concat(block.block, le32(block.nextKey.algorithm), block.nextKey.key, block.signature);
}

export function sign(payload: Uint8Array, secret: Uint8Array, algorithm: number): Uint8Array {
  if (algorithm === ALG_ED25519) return ed25519.sign(payload, secret);
  if (algorithm === ALG_SECP256R1)
    return p256.sign(payload, secret, { format: "der", prehash: true });
  throw new SignatureError(`unknown algorithm ${algorithm}`);
}

/** a fresh keypair for the given algorithm */
export function generateKeypair(algorithm: 0 | 1 = 0): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const secretKey =
    algorithm === ALG_ED25519 ? ed25519.utils.randomSecretKey() : p256.utils.randomSecretKey();
  return { secretKey, publicKey: publicKeyFromSecret(secretKey, algorithm) };
}

export { bytesEqual };

/* --------------------------------------------------------------- verifying */

interface SignatureCheck {
  key: PublicKeyMsg;
  payload: Uint8Array;
  signature: Uint8Array;
  error: string;
}

/**
 * Everything verifying a token requires, as data: the signatures to check, in
 * chain order, and — for an unsealed token — the proof secret whose public key
 * must equal the last block's next key. Structural problems throw here, before
 * any signature is looked at. `verifyToken` and `verifyTokenAsync` both consume
 * this, so neither can skip a check the other makes.
 */
function chainChecks(
  token: BiscuitMsg,
  rootPublicKey: Uint8Array,
  rootAlgorithm: number,
): { checks: SignatureCheck[]; proof?: { secret: Uint8Array; key: PublicKeyMsg } } {
  const root: PublicKeyMsg = { algorithm: rootAlgorithm as 0 | 1, key: rootPublicKey };
  const checks: SignatureCheck[] = [];

  if (token.authority.externalSignature)
    throw new SignatureError("the authority block must not carry an external signature");

  const authVersion = token.authority.version ?? 0;
  const authPayload =
    authVersion === 0
      ? blockPayloadV0(token.authority.block, token.authority.nextKey)
      : authVersion === 1
        ? authorityPayloadV1(token.authority.block, token.authority.nextKey, authVersion)
        : (() => {
            throw new SignatureError(`unsupported block version ${authVersion}`);
          })();
  checks.push({
    key: root,
    payload: authPayload,
    signature: token.authority.signature,
    error: "invalid authority block signature",
  });

  let currentKey = token.authority.nextKey;
  let previousSignature = token.authority.signature;

  for (const block of token.blocks) {
    const version = block.version ?? 0;
    const externalSig = block.externalSignature?.signature;
    let payload: Uint8Array;
    if (version === 0) payload = blockPayloadV0(block.block, block.nextKey, externalSig);
    else if (version === 1)
      payload = blockPayloadV1(block.block, block.nextKey, externalSig, previousSignature, version);
    else throw new SignatureError(`unsupported block version ${version}`);

    checks.push({
      key: currentKey,
      payload,
      signature: block.signature,
      error: "invalid block signature",
    });

    if (block.externalSignature) {
      if (version !== 1) throw new SignatureError("unsupported third party block version");
      checks.push({
        key: block.externalSignature.publicKey,
        payload: externalPayloadV1(block.block, previousSignature, version),
        signature: block.externalSignature.signature,
        error: "invalid external signature",
      });
    }

    currentKey = block.nextKey;
    previousSignature = block.signature;
  }

  if (token.proof.kind === "nextSecret") {
    return { checks, proof: { secret: token.proof.value, key: currentKey } };
  }
  const last = token.blocks.length ? token.blocks[token.blocks.length - 1] : token.authority;
  checks.push({
    key: currentKey,
    payload: sealPayloadV0(last),
    signature: token.proof.value,
    error: "invalid seal signature",
  });
  return { checks };
}

/** Verifies the full signature chain and the proof. Throws on failure. */
export function verifyToken(token: BiscuitMsg, rootPublicKey: Uint8Array, rootAlgorithm = 0): void {
  const { checks, proof } = chainChecks(token, rootPublicKey, rootAlgorithm);
  for (const check of checks)
    if (!verifySignature(check.key, check.payload, check.signature))
      throw new SignatureError(check.error);
  if (proof && !bytesEqual(publicKeyFromSecret(proof.secret, proof.key.algorithm), proof.key.key))
    throw new SignatureError("the last public key does not match the private key");
}

/**
 * `verifyToken`, using the platform's WebCrypto for Ed25519 where it offers it
 * — about ten times faster than the pure-JS path in Node and current browsers.
 * secp256r1, and any runtime without WebCrypto Ed25519, fall back to
 * `@noble/curves`, so the result never depends on where it runs.
 */
export async function verifyTokenAsync(
  token: BiscuitMsg,
  rootPublicKey: Uint8Array,
  rootAlgorithm = 0,
): Promise<void> {
  const { checks, proof } = chainChecks(token, rootPublicKey, rootAlgorithm);
  const [verdicts, derived] = await Promise.all([
    Promise.all(checks.map((c) => verifySignatureAsync(c.key, c.payload, c.signature))),
    proof ? publicKeyFromSecretAsync(proof.secret, proof.key.algorithm) : undefined,
  ]);
  verdicts.forEach((ok, i) => {
    if (!ok) throw new SignatureError(checks[i].error);
  });
  if (proof && !bytesEqual(derived as Uint8Array, proof.key.key))
    throw new SignatureError("the last public key does not match the private key");
}

/* ------------------------------------------------------ WebCrypto Ed25519 */

type Subtle = {
  importKey(
    format: string,
    data: Uint8Array,
    algorithm: { name: string },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  verify(algorithm: string, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  exportKey(format: "jwk", key: unknown): Promise<{ x?: string }>;
};

const subtle = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;

/** PKCS#8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410) */
const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

let ed25519Native: Promise<boolean> | undefined;

/** Whether this runtime's WebCrypto verifies Ed25519, and does so correctly. Probed once. */
function nativeEd25519(): Promise<boolean> {
  ed25519Native ??= (async () => {
    if (!subtle) return false;
    try {
      const secret = new Uint8Array(32).fill(7);
      const message = ascii("webrun-biscuit");
      const signature = ed25519.sign(message, secret);
      const key = await subtle.importKey(
        "raw",
        ed25519.getPublicKey(secret),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const forged = signature.slice();
      forged[0] ^= 1;
      return (
        (await subtle.verify("Ed25519", key, signature, message)) &&
        !(await subtle.verify("Ed25519", key, forged, message))
      );
    } catch {
      return false;
    }
  })();
  return ed25519Native;
}

async function verifySignatureAsync(
  key: PublicKeyMsg,
  payload: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  if (key.algorithm !== ALG_ED25519 || !subtle || !(await nativeEd25519()))
    return verifySignature(key, payload, sig);
  if (key.key.length !== 32 || sig.length !== 64) return false;
  try {
    const imported = await subtle.importKey("raw", key.key, { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify("Ed25519", imported, sig, payload);
  } catch {
    return false;
  }
}

async function publicKeyFromSecretAsync(secret: Uint8Array, algorithm: number): Promise<Uint8Array> {
  if (algorithm !== ALG_ED25519 || secret.length !== 32 || !subtle || !(await nativeEd25519()))
    return publicKeyFromSecret(secret, algorithm);
  try {
    const pkcs8 = new Uint8Array(PKCS8_ED25519.length + 32);
    pkcs8.set(PKCS8_ED25519);
    pkcs8.set(secret, PKCS8_ED25519.length);
    const key = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const { x } = await subtle.exportKey("jwk", key);
    if (x === undefined) return publicKeyFromSecret(secret, algorithm);
    return fromBase64(x);
  } catch {
    return publicKeyFromSecret(secret, algorithm);
  }
}

/** Revocation identifier of each block: its signature bytes. */
export function revocationIds(token: BiscuitMsg): Uint8Array[] {
  return [token.authority, ...token.blocks].map((b) => b.signature);
}
