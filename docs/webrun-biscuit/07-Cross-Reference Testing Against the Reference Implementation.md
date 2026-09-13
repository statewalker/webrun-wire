# Cross-Reference Testing Against the Reference Implementation

_Working document — 12 September 2026_

Conformance against a corpus proves we agree with a *recording* of the
reference implementation. It does not prove we interoperate with the
implementation itself — in particular it says nothing about tokens **we**
produce, because the corpus contains none.

This note records how that gap was closed, and what it cost.

## 1. Getting a real reference into the test process

### The Rust route, abandoned

The container had no Rust. `cargo` 1.75 installs from the Ubuntu archive, so a
helper binary was written against `biscuit-auth` and the dependency tree pinned
crate by crate: `base64ct`, `time`, `time-core`, `zeroize`, `subtle`,
`rand_core`, `ed25519-dalek` — each newer release requiring either edition2024
or a higher MSRV.

The wall: **`biscuit-auth` at HEAD needs rustc ≥ 1.79**. Ubuntu 24 ships
nothing newer and `static.rust-lang.org` is not reachable from the sandbox.

The helper source is kept at `code/test/cross/rust-helper/` for anyone on a
current toolchain. It is not what the suite runs.

### The WASM route, taken

`@biscuit-auth/biscuit-wasm` is the same Rust crate compiled to WebAssembly and
published by the biscuit project. Not a reimplementation — which is the only
thing that makes these tests meaningful.

It is also the better engineering answer: the cross-tests now run anywhere Node
runs, with no toolchain at all.

## 2. What is actually on npm

| package | what it is |
|---|---|
| `@biscuit-auth/biscuit-wasm` 0.6.0 | the token API as precompiled WASM — the only one |
| `@biscuit-auth/biscuit-wasm-support` 0.6.0 | **not** the token API: the playground backend (`run_app`, `execute`, `inspect_snapshot`) |
| `@smithery/biscuit` | third-party Cloudflare Workers adapter over the first |

18 published versions, no Node-target build, `exports` is
`{ import: "./module/biscuit.js" }` — bundler target only.

## 3. Four obstacles to loading it in Node

1. **The entry point cannot be resolved.** It does
   `import * as wasm from "./biscuit_bg.wasm"`, which Node will not resolve;
   and the `exports` map has no `require` condition, so `require.resolve`
   fails too. `reference.ts` finds the package by walking up to
   `node_modules`, reads the `.wasm`, and supplies its imports by hand: the
   wasm-bindgen glue plus each of the seven `snippets/<hash>/inline0.js` files.
   (`node --experimental-wasm-modules` imports it directly and works — but
   requiring a flag for `pnpm test` is worse.)
2. **Run limits are a serde `Duration`.** `max_time` must be
   `{ secs, nanos }`. A plain number of nanoseconds does **not** error:
   deserialization fails quietly and the *default* 1 ms limit applies, which
   then times out. It looks exactly like a slow engine. Three debugging rounds.
3. **The clock misreads its first interval.** The first `authorize` on any
   Authorizer reports a RunLimit timeout even with a 60-second budget; later
   calls on the same object return in under a millisecond. `referenceOutcome`
   retries twice, so a genuine timeout still fails.
4. **`PublicKey.toBytes()` throws.** `toString()` returns
   `"<algorithm>/<hex>"` and is the reliable accessor.

None of these are documented anywhere. They are now documented in the README.

## 4. The suite — 48 tests, `test/cross/`

| file | direction |
|---|---|
| `01-native-to-ts` | the reference mints, we read |
| `02-ts-to-native` | we mint, the reference reads |
| `03-interop-chains` | both append blocks to the same chain |

`01` is a true **differential** test: it does not merely check our verdict
against an annotation, it has the reference authorize its own token and asserts
we reach the same verdict, the same policy index, and identical revocation
identifiers.

18 token shapes in `cases.ts`: attenuation, rule derivation, scoping, sealing,
expressions, sets, dates, bytes, bitwise operators, regex, multi-block, deny
policies, no-matching-policy, `check all`, closures, maps, `reject if`.

## 5. Three results worth keeping

**A wrong assumption of ours, caught.** The case `scoped-rule-cannot-grant` was
annotated `ok`. Both implementations say `noMatchingPolicy` — and they are
right. A rule in an attenuation block may read authority facts, but the fact it
derives carries origin `{0,1}`, which the authorizer does not trust by default.
An attenuation block therefore cannot grant rights, even indirectly through a
rule. That is a security guarantee, and it is now asserted deliberately rather
than assumed.

**Mixed chains work.** A four-block chain where we and the reference alternate
appending verifies on both sides, and all four checks still bite when the
authorizer drops a fact. Our v1 signature payloads and the reference's blocks
interleave correctly.

**The arrays/maps version quirk, confirmed empirically.** Previously it was
read out of the Rust source; now it is measured. The reference stamps **v3** on
a block containing an array or a map, v4 for scopes and `check all`, and v6
only once `null` or `reject if` appears. Our `requiredVersion()` agrees on all
seven probes. The quirk is real, and mirroring it was the right call.

The pinned reference (0.6.0) supports every v3.3 feature tested, so the
skip paths never fire.

## 6. Open threads

- **Random differential testing.** The 18 cases are hand-written. Generating
  random valid tokens and comparing verdicts would cover the space between
  "these shapes" and "arbitrary tokens". This is the most valuable remaining
  test work.
- **secp256r1 is untested across the boundary.** Every cross case uses Ed25519;
  the reference's `KeyPair` takes an algorithm argument, so extending is cheap.
- **The reference is pinned by npm semver**, not by integrity hash. A future
  0.6.x could change behaviour under the suite.
- **No CI**, so nothing runs either suite on change.
- **`biscuit-web-key`** remains unexamined, and **authorizer snapshots**
  remain unimplemented.
