/**
 * Biscuit cryptography: chained block signatures, sealing, third-party
 * (external) signatures. Ed25519 and ECDSA/secp256r1, per SPECIFICATIONS.md.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
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

/** Verifies the full signature chain and the proof. Throws on failure. */
export function verifyToken(token: BiscuitMsg, rootPublicKey: Uint8Array, rootAlgorithm = 0): void {
  const root: PublicKeyMsg = { algorithm: rootAlgorithm as 0 | 1, key: rootPublicKey };

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
  if (!verifySignature(root, authPayload, token.authority.signature))
    throw new SignatureError("invalid authority block signature");

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

    if (!verifySignature(currentKey, payload, block.signature))
      throw new SignatureError("invalid block signature");

    if (block.externalSignature) {
      if (version !== 1) throw new SignatureError("unsupported third party block version");
      const ext = externalPayloadV1(block.block, previousSignature, version);
      if (
        !verifySignature(block.externalSignature.publicKey, ext, block.externalSignature.signature)
      )
        throw new SignatureError("invalid external signature");
    }

    currentKey = block.nextKey;
    previousSignature = block.signature;
  }

  if (token.proof.kind === "nextSecret") {
    const derived = publicKeyFromSecret(token.proof.value, currentKey.algorithm);
    if (!bytesEqual(derived, currentKey.key))
      throw new SignatureError("the last public key does not match the private key");
  } else {
    const last = token.blocks.length ? token.blocks[token.blocks.length - 1] : token.authority;
    if (!verifySignature(currentKey, sealPayloadV0(last), token.proof.value))
      throw new SignatureError("invalid seal signature");
  }
}

/** Revocation identifier of each block: its signature bytes. */
export function revocationIds(token: BiscuitMsg): Uint8Array[] {
  return [token.authority, ...token.blocks].map((b) => b.signature);
}
