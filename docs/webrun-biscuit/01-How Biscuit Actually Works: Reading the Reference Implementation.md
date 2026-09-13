# How Biscuit Actually Works: Reading the Reference Implementation

_Working document — 12 September 2026_

Findings from reading `eclipse-biscuit/biscuit-rust` (v6.0.0, spec v3.3) in
order to reimplement it. This is the mechanical knowledge a second
implementation needs and that the prose specification leaves implicit.

## 1. Four layers, not one

| layer | size in Rust | what it owns |
|---|---|---|
| crypto | ~800 lines | chained block signatures, sealing, third-party signatures |
| serialization | 20 proto2 messages | the wire format |
| symbol table | ~150 lines | string interning, 28 defaults, offset 1024 |
| datalog | ~1500 lines | origin-tracked fixpoint, expression VM |

They are separable. Verification touches crypto + serialization only;
authorization adds the other two.

## 2. The signature chain

Each block carries the public key of the *next* block, signed by the *previous*
key. The `proof` field holds either the next secret key (token still
attenuable) or a final signature (sealed).

There are two signed-payload layouts and the choice is per block:

```
v0: data ‖ [external_sig] ‖ le32(next_alg) ‖ next_pk

v1: "\0BLOCK\0\0VERSION\0" ‖ le32(version)
    "\0PAYLOAD\0"    ‖ data
    "\0ALGORITHM\0"  ‖ le32(next_alg)
    "\0NEXTKEY\0"    ‖ next_pk
    "\0PREVSIG\0"    ‖ previous_signature
    ["\0EXTERNALSIG\0" ‖ external_sig]
```

The authority block's v1 payload omits `PREVSIG` (there is no previous
signature). Third-party blocks **must** use v1. The seal payload is always v0:
`data ‖ le32(alg) ‖ next_pk ‖ signature` of the last block.

`le32` is the little-endian **i32** encoding — of the algorithm id and of the
version number alike.

## 3. Evaluation order in the authorizer

This ordering is observable in the error results, so it has to be reproduced
exactly:

1. authorizer checks
2. authority (block 0) checks
3. **policies** — first match wins, loop breaks
4. checks of blocks 1..n

Failures accumulate into a list rather than short-circuiting. The final mapping:

| policy matched | errors empty | result |
|---|---|---|
| allow(i) | yes | `Ok(i)` |
| allow(i) | no | `Unauthorized { Allow(i), checks }` |
| deny(i) | any | `Unauthorized { Deny(i), checks }` |
| none | any | `NoMatchingPolicy { checks }` |

A non-empty error list beats a matching allow. That is the whole safety
property of the check mechanism.

## 4. Origins are the trust mechanism

Every fact carries an **origin**: the set of block ids that contributed to it.
A base fact from block *n* has origin `{n}`; a derived fact gets the union of
the origins of every fact it matched, plus the block id of the rule.

A rule only sees facts whose origin is a **subset** of its `TrustedOrigins`.
The authorizer's own block id is `usize::MAX`. Default trusted set is
`{authorizer, 0}` plus the current block. `trusting ed25519/<hex>` adds the
block ids signed by that key.

This is how an attenuation block cannot grant itself rights: its facts have
origin `{1}`, which is not a subset of the authority block's trusted set.

## 5. The expression VM

A postfix stack machine: `Value | Unary | Binary | Closure(params, ops)`.
Closures push themselves; a binary op that pops a closure evaluates it lazily.
That is how `&&`, `||`, `.any()`, `.all()` and `.try_or()` are implemented — there
is no separate control flow.

Traps worth recording:

- `a.try_or(b)` compiles to `[Closure([], a), b, TryOr]` — the **closure is
  what gets tried**, the argument is the fallback. The opcode order is the
  reverse of the surface syntax.
- Closure parameters that shadow a bound variable raise `ShadowedVariable`
  *before* evaluation.
- Integers are i64 with **checked** arithmetic: overflow is an error, not
  wraparound.
- `.length()` on a string is the UTF-8 **byte** length.
- Regex is Rust's `regex` crate: RE2, unanchored, and an invalid pattern
  yields `false` rather than an error.
- Strict `===` on mismatched types is a type error; lenient `==` returns
  `false`.

## 6. The conformance corpus

`biscuit-auth/samples/` is the cross-implementation suite — Haskell, Java and
Go consume the same files. 38 tokens, 50 validations. Each testcase gives the
`.bc` binary, a per-block Datalog source listing, and for each authorizer
program the expected result and revocation ids.

It exercises crypto, protobuf, symbol tables, scoping, expressions and error
shapes in one artifact. It is the single most valuable thing in the repository
for anyone writing a second implementation.

## 7. Open threads

- The `InvalidBlockRule` error reports block id `0` regardless of which block
  the offending rule is in (`builder/authorizer.rs:490` hardcodes it). Bug or
  intentional? We reproduce it to stay conformant, but it should be raised
  upstream.
- Public key interning order across blocks was inferred from
  `symbols.public_keys.extend(...)` calls rather than documented. A token with
  many third-party blocks could expose an ordering we got wrong.
- The spec does not state that verifiers must accept high-S ECDSA signatures;
  we only discovered it from a sample. Worth an upstream clarification.
