/**
 * biscuit-ts — pure TypeScript Biscuit tokens.
 *
 *   const root = generateKeypair();
 *   const token = Biscuit.build(root.secretKey, 'user("alice");');
 *   const text  = token.toBase64();
 *   const ok    = Biscuit.fromBase64(text).verify(root.publicKey).authorize('allow if user("alice");');
 */

import {
  type AuthorizationResult,
  type AuthorizeOptions,
  authorize,
  type Evaluation,
  evaluate,
  type LoadedToken,
  loadToken,
  loadTokenAsync,
} from "./authorizer.js";
import { fromBase64, toBase64 } from "./base64.js";
import {
  appendThirdParty,
  attenuate,
  type BuildOptions,
  buildToken,
  generateKeypair,
  sealToken,
  type ThirdPartyResponse,
  thirdPartyBlock,
  thirdPartyRequest,
} from "./builder.js";

export * from "./authorizer.js";
export * from "./base64.js";
export * from "./builder.js";
export { SignatureError } from "./crypto.js";
export {
  ExecutionError,
  type ExternFn,
  type Predicate,
  type RunLimits,
  type Term,
} from "./datalog.js";
export { type ParamValue, type Params, ParseError } from "./parser.js";
export { ProtoError } from "./proto.js";
export * from "./version.js";

/** An unverified token: it can be attenuated and re-serialized. */
export class Biscuit {
  private constructor(readonly bytes: Uint8Array) {}

  static build(rootSecret: Uint8Array, code: string, options?: BuildOptions): Biscuit {
    return new Biscuit(buildToken(rootSecret, code, options));
  }
  static fromBytes(bytes: Uint8Array): Biscuit {
    return new Biscuit(bytes);
  }
  static fromBase64(text: string): Biscuit {
    return new Biscuit(fromBase64(text));
  }

  attenuate(code: string, options?: BuildOptions): Biscuit {
    return new Biscuit(attenuate(this.bytes, code, options));
  }
  appendThirdParty(response: ThirdPartyResponse, options?: BuildOptions): Biscuit {
    return new Biscuit(appendThirdParty(this.bytes, response, options));
  }
  thirdPartyRequest() {
    return thirdPartyRequest(this.bytes);
  }
  seal(): Biscuit {
    return new Biscuit(sealToken(this.bytes));
  }
  toBase64(): string {
    return toBase64(this.bytes);
  }

  /** Verify the signature chain. Throws if the token is not authentic. */
  verify(rootPublicKey: Uint8Array, rootAlgorithm: 0 | 1 = 0): VerifiedBiscuit {
    return new VerifiedBiscuit(loadToken(this.bytes, rootPublicKey, rootAlgorithm), this.bytes);
  }

  /**
   * `verify`, using WebCrypto Ed25519 where the platform has it — roughly ten
   * times faster than the pure-JS path. Rejects exactly where `verify` throws.
   */
  async verifyAsync(rootPublicKey: Uint8Array, rootAlgorithm: 0 | 1 = 0): Promise<VerifiedBiscuit> {
    return new VerifiedBiscuit(
      await loadTokenAsync(this.bytes, rootPublicKey, rootAlgorithm),
      this.bytes,
    );
  }
}

/** A token whose signature chain has been checked against a root key. */
export class VerifiedBiscuit {
  constructor(
    readonly token: LoadedToken,
    readonly bytes: Uint8Array,
  ) {}
  get revocationIds(): string[] {
    return this.token.revocationIds;
  }
  /** the issuer's key identifier, when the token carries one */
  get rootKeyId(): number | undefined {
    return this.token.rootKeyId;
  }
  authorize(authorizerCode: string, options?: AuthorizeOptions): AuthorizationResult {
    return authorize(this.token, authorizerCode, options);
  }
  /** Authorize, keeping the evaluated world available to `query`. */
  evaluate(authorizerCode: string, options?: AuthorizeOptions): Evaluation {
    return evaluate(this.token, authorizerCode, options);
  }
}

export { generateKeypair, thirdPartyBlock };
