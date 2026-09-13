# What the Red-Green Cycle Caught

_Working document — 12 September 2026_

The implementation was built test-first, milestone by milestone, against the
upstream conformance corpus. This records the bugs the cycle surfaced — every
one of them was invisible to reading the specification, and several would have
shipped as silent security defects.

## 1. The secp256r1 signature (four debugging rounds)

Ed25519 passed 35 samples immediately. `test036_secp256r1` failed. The
diagnosis path is worth keeping because the obvious hypothesis was wrong:

1. Assumed the payload layout was wrong → tried six payload variants, all false.
2. Used **ECDSA public-key recovery** on the signature to recover which key
   signed which digest. It matched `authority.nextKey` on the v1 payload —
   proving the byte layout and the key choice were both correct, so the bug had
   to be in the noble call.
3. Manual ECDSA point arithmetic (`u1·G + u2·P`, compare x to r) returned
   `true`, confirming the mathematics.
4. Found it: `@noble/curves` v2 needs `{ format: 'der', prehash: true, lowS: false }`.

Two independent traps in one call:

- **`prehash`** — noble hashes the message itself; passing a pre-computed
  SHA-256 digest makes it hash the digest again.
- **`lowS`** — noble rejects high-S signatures by default (a Bitcoin
  malleability convention). RustCrypto's `ecdsa` does not enforce it on
  verification, and the sample's signature is high-S.

Without `lowS: false` the library rejects roughly half of all valid secp256r1
tokens, non-deterministically. No amount of reading the spec would have found
this; only a real signature from the reference implementation did.

## 2. try_or had inverted opcode order

`(1/0).try_or(true)` threw `DivideByZero` instead of returning `true`. The
parser was emitting `[X, closure(Y), TryOr]`, so `X` was evaluated eagerly.
The reference emits `[closure(X), Y, TryOr]` — confirmed against
`biscuit-parser`'s own `try_expr` unit test. The closure is what gets *tried*.

## 3. Variable names can start with a digit

`$0` broke every check in the corpus: the name lexer required a letter as the
first character. Predicate names and variable names have different lexical
rules, which the grammar does not make obvious.

## 4. Block rules are validated, not silently dropped

`test018` expects `InvalidBlockRule` — a rule whose head uses a variable the
body never binds is rejected at **load time**, before evaluation. The expected
error quotes the rule source, so a pretty-printer was required to match it
byte-for-byte, which it now does.

The reference reports block id `0` for this error regardless of which block the
rule lives in. We reproduce the quirk deliberately, with a comment.

## 5. Extern functions are caller-supplied

`test035_ffi` needs a function named `test` registered by the authorizer. This
surfaced a missing piece of API rather than a bug: `authorize()` gained an
`externs` option.

## 6. Mutation testing, to check the suite has teeth

A green suite you tuned into passing proves little. Three deliberate breakages:

| mutation | tests that failed |
|---|---|
| drop `lowS: false` from p256 verify | 3 |
| disable `check all` semantics | 1 |
| make i64 addition wrap instead of erroring | 2 |

All three caught; suite returned to zero failures on restore. A coverage guard
asserts that all 38 samples and all 50 validations actually ran, so the suite
cannot pass vacuously by skipping cases.

## 7. The corpus, run backwards

For the write path, the same corpus was reused in reverse: rebuild each
first-party token from its Datalog source, then verify and re-authorize it and
assert the same result. This catches any asymmetry between the encoder and the
decoder — a class of bug the forward test cannot see, because the forward test
only ever reads bytes the reference produced.

## 8. Open threads

- Differential testing against `@biscuit-auth/biscuit-wasm` on randomly
  generated tokens has not been done. It would cover the space between "the 38
  samples" and "arbitrary valid tokens".
- The fuzzing is deterministic (seeded PRNG, 400 mutations, 500 random inputs).
  A real fuzzer with coverage feedback would be better and is not wired up.
- Nothing tests behaviour under adversarial run-limit pressure — e.g. a token
  crafted so the fixpoint is expensive but stays just under `maxFacts`.
