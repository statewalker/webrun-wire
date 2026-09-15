# @statewalker/webrun-biscuit

[Biscuit](https://biscuitsec.org) authorization tokens in pure TypeScript: the protobuf codec, the
signature chain, the Datalog engine, the text parser, the authorizer and the token builder. No WASM,
no Node built-ins in `src/`, two runtime dependencies. It runs wherever the rest of the wire runs —
Node, browsers, Workers and Durable Objects.

## Why this package exists

There is no other pure JS/TS Biscuit implementation. npm carries `@biscuit-auth/biscuit-wasm` — the
Rust crate compiled to WebAssembly — and a web-components package built on it. Nothing else.

For a browser-first or Durable-Object context a WASM blob is a real cost, not a stylistic objection:
bundle size, an instantiation step, and a platform surface that is not available everywhere. A token
format whose whole point is that the holder can attenuate it locally should not require half a
megabyte of WebAssembly to do so.

So this is a reimplementation, and the entire testing strategy below exists because a reimplementation
of a security primitive is only worth having if you can show it agrees with the original.

## Installing and calling it

```sh
npm install @statewalker/webrun-biscuit
```

Two runtime dependencies, both external to the published bundle:
[`@noble/curves`](https://www.npmjs.com/package/@noble/curves) and
[`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes). ESM only.

Mint a token, attenuate it, seal it, then verify and authorize:

```ts
import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";

const root = generateKeypair();

const token = Biscuit.build(root.secretKey, 'user("alice"); right("file1", "read");')
  .attenuate('check if operation("read");')
  .seal()
  .toBase64();

const verified = Biscuit.fromBase64(token).verify(root.publicKey);
const result = verified.authorize('operation("read"); allow if user("alice");');
// { kind: 'ok', policy: 0 }
```

`verify()` throws on an inauthentic token and returns a `VerifiedBiscuit`. That is deliberate: the
type system then prevents authorizing a token whose signature chain was never checked, which is the
mistake worth designing against.

### Parameters: never splice a value into Datalog

Anything that did not come from you — a user id, a request path, a role name —
goes in as a `{name}` parameter. It is bound as a **term**, so no string can
change the shape of the program:

```ts
const token = Biscuit.build(root.secretKey, "user({id});", { params: { id: userId } });
verified.authorize("resource({path});\nallow if user($u), owner($u, {path});", {
  params: { path: url.pathname },
});
```

Strings, safe-integer numbers, `bigint`, booleans, `null`, `Date`, `Uint8Array`,
arrays and `Set`s are accepted. An unbound parameter and an unused one are both a
`ParseError`, as in the reference; `{true}`, `{false}` and `{null}` remain one-element
sets.

### Querying the evaluated world

`evaluate` is `authorize` that keeps the world, so facts can be read back — the
reference's `Authorizer::query`. A query sees what the authorizer sees (authority
block and authorizer facts) unless it says `trusting`, so an attenuation block cannot
inject what it reads:

```ts
const ev = verified.evaluate("allow if true;");
ev.result;                                   // { kind: "ok", policy: 0 }
ev.query("claim($s) <- subject($s)");        // [{ name: "claim", terms: [{ t: "str", v: "alice" }] }]
```

Pass `null` instead of a token to decide from the authorizer's own facts and rules:

```ts
import { evaluate } from "@statewalker/webrun-biscuit";
evaluate(null, 'role("admin");\ncapability("x") <- role("admin");').query("c($c) <- capability($c)");
```

A failed check carries its rule text, printed exactly as the reference prints it:
`{ source: "block", blockId: 0, checkId: 0, rule: "check if bound($k), connection_peer($k)" }`.

### Faster verification: `verifyAsync`

`verify` is synchronous and pure JS. `verifyAsync` checks Ed25519 signatures with the
platform's WebCrypto where it has it — Node, current browsers, Workers — which is about
eight times faster (0.25 ms against 1.9 ms per token in Node 24). secp256r1, and any
runtime without WebCrypto Ed25519, fall back to the same pure-JS code, and both paths
consume one list of signature checks, so neither can skip a check the other makes.

```ts
const verified = await Biscuit.fromBase64(token).verifyAsync(root.publicKey);
```

### Examples

secp256r1 works the same way, with the algorithm passed at both ends:

```ts
const root = generateKeypair(1);
const token = Biscuit.build(root.secretKey, 'user("alice");', { algorithm: 1 });
const verified = Biscuit.fromBase64(token.toBase64()).verify(root.publicKey, 1);
```

For key rotation, read the issuer's key id before choosing a root key. The token is unverified at
that point, so treat the id as a hint rather than a claim:

```ts
import { peekRootKeyId } from "@statewalker/webrun-biscuit";

const key = roots[peekRootKeyId(bytes) ?? 0];
```

A third party can sign a block without ever holding the token:

```ts
const request = Biscuit.fromBase64(token).thirdPartyRequest();
const response = thirdPartyBlock(request, externalSecret, 'group("admin");');
const extended = Biscuit.fromBase64(token).appendThirdParty(response);
```

## Internals

### How the modules stack up

Each module depends only on the ones above it.

| path | what it does |
| --- | --- |
| `src/proto.ts` | strict proto2 codec — BigInt int64, presence tracking, UTF-8 validation, unknown-field rejection |
| `src/crypto.ts` | Ed25519 + secp256r1 chain, payload v0/v1, sealing, external signatures |
| `src/datalog.ts` | term model, canonical keys, origin-tracked fixpoint engine, expression VM |
| `src/parser.ts` | Datalog text syntax to the runtime model |
| `src/print.ts` | pretty-printer for error messages and world snapshots |
| `src/version.ts` | block version bounds and Datalog feature gates |
| `src/authorizer.ts` | symbol resolution, block loading, authorization, world snapshots |
| `src/builder.ts` | minting, attenuation, sealing, third-party blocks |
| `src/base64.ts` | URL-safe base64, runtime-agnostic |
| `src/index.ts` | the public API — `Biscuit`, `VerifiedBiscuit` |

The one awkward edge is that `builder` imports `parseAuthorizer` and `DEFAULT_SYMBOLS` from
`authorizer`. Both are block-level concerns that happen to live there; it is a naming artefact rather
than a layering problem, and it would move to a `symbols.ts` if the file grew.

### Decisions that would otherwise get undone

**Terms are compared through canonical string keys.** JS `Map` and `Set` are reference-keyed, while
the Rust implementation leans on derived `Hash`/`Ord` over a `BTreeSet`. Every structural comparison
and every de-duplication in the engine therefore goes through `termKey()`. Bypassing it gives you a
set that silently holds duplicates.

**Symbols are resolved to strings at load time** rather than kept as indices. Simpler, and
semantically equivalent — the only observable difference is that set ordering follows string order
instead of symbol-index order, which shows up in printing and not in results.

**Facts are indexed by `name/arity`**, cached per trusted-origin set and invalidated by a generation
counter, so a join never scans unrelated predicates.

**`Uint8Array` everywhere, never `Buffer`**, in `src/`. That is what makes the package runtime-
agnostic; tests may use Node APIs, the library may not.

**Default run limits are looser than the reference.** The reference defaults `max_time` to 1
millisecond, which is unreachably tight for a cold JS engine; this one defaults to 1 second. A caller
exposed to untrusted tokens should lower it deliberately rather than treat the default as a
denial-of-service bound. The limit is enforced where the work happens — inside the join, for rules,
checks and policies alike — so it bounds a single combinatorial rule, not only the number of
iterations (up to 0.2.0 it was read only between iterations).

### The corpus is fetched, not vendored

`scripts/fetch-samples.mjs` downloads the official corpus into `samples/` (gitignored), pinned to
commit `b3d3fe2` of the **specification repository**,
[`eclipse-biscuit/biscuit`](https://github.com/eclipse-biscuit/biscuit). The samples belong to the
biscuit project, so they are not copied into this repo.

The canonical corpus lives in `samples/current` there, **not** in any single implementation: the copy
shipped inside `biscuit-rust` has drifted, and differs in `samples.json` and `test034_array_map.bc`
by one check.

The deprecated `v1` and `v2` corpora are fetched too, as negative fixtures. A current implementation
must reject them: every block declares a Datalog version, and versions outside 3 to 6 are invalid.
Without that check a v2 token verifies cleanly, which is a vulnerability rather than a compatibility
nicety.

Beyond the final authorization result, `09-world-snapshot` compares the entire post-run world against
the corpus — every derived fact, with its origin set. That catches rule-evaluation errors that happen
not to change the verdict.

### A green suite is not the claim; a suite that can fail is

```sh
pnpm test          # the main suite, 182 tests
pnpm test:cross    # against the reference implementation, 58 tests
pnpm test:all      # both
pnpm mutate        # inject 15 known defects, require the suite to catch each
pnpm build         # dist/ plus declarations
```

| file | covers |
| --- | --- |
| `01-proto` | byte-exact round-trip of all 38 sample tokens, i64 extremes, strict rejection |
| `02-crypto` | signature chain outcomes and revocation ids for all samples |
| `03-datalog` | engine unit tests ported from the Rust `datalog` module |
| `04-parser` | terms, precedence, closures, scopes, predicate/expression disambiguation, the reference's name and arity rules |
| `05-conformance` | the official `samples.json` corpus — 38 tokens, 50 validations |
| `06-builder` | write path, corpus rebuilt from source, forged seals, deny policies |
| `07-api` | base64 and the public facade |
| `08-hardening` | property round-trips, mutation/truncation fuzzing, join scaling |
| `09-world-snapshot` | the post-run world per origin, against the official snapshots |
| `10-versions` | version bounds, feature gates, rejection of the deprecated v1/v2 corpora |
| `11-parameters` | `{name}` binding, hostile strings, unbound and unused parameters |
| `12-evaluate` | queries, their scope, token-less evaluation, failed-check rule text |

`scripts/mutate.mjs` is the check on all of it. It injects fifteen defects — a lenient protobuf decoder,
wrapping i64 arithmetic, `check all` degraded to `check if`, a universally trusting authorizer, `deny`
treated as `allow`, unchecked seal signatures, an async verifier that ignores WebCrypto's verdict, a
query that can read an attenuation block's facts, silently ignored parameters, zero-term predicates, non-ASCII names, missing version bounds,
and more — and requires each to break at least one test. A surviving mutation is a hole in the tests,
not a success. All fifteen are caught. Two of them were **not** caught when the harness was first written: nothing verified a forged
seal signature, and nothing exercised a matching `deny` policy.

Each mutation's `find` string is a literal excerpt of the source, and must match exactly once. That is
why a reformat of `src/` makes the harness fail loudly rather than quietly stop testing anything.

### Cross-reference tests run against the reference itself

`tests/cross/` checks interoperability against the Rust `biscuit-auth` crate compiled to WebAssembly
and published as `@biscuit-auth/biscuit-wasm`. These tests are only meaningful because the other side
is genuinely upstream, not a second reading of the same spec.

| file | direction |
| --- | --- |
| `01-native-to-ts` | the reference mints, we read — including a differential check on verdict, policy index and revocation ids |
| `02-ts-to-native` | we mint, the reference reads |
| `03-interop-chains` | blocks appended alternately by both, sealing honoured across the boundary, base64 interop, agreement on the stamped Datalog version |
| `04-random-differential` | generated programs, both directions, both algorithms — the reference is the oracle |
| `05-grammar` | predicate and variable names, and arity — the recorded table and generated names, re-asked of the reference |

Nothing in `04` hard-codes the expected answer: each generated program is authorized by both
implementations and the verdicts compared, so a disagreement is a finding either way. Programs are
built around a (resource, operation, user) scenario and then perturbed rather than sampled uniformly,
because uniform sampling produces mostly `noMatchingPolicy`, where the engine barely runs.

That suite is kept out of `pnpm test` on purpose, and it skips gracefully when the reference is not
installed, so it never becomes a hard dependency of the main suite.

## What will surprise you

**The reference build's first `authorize` call reports a timeout that is not real.** Every fresh
Authorizer reports a `RunLimit` timeout on its first call even with a 60-second budget; later calls on
the same object return in under a millisecond. `referenceOutcome` retries, so a genuine timeout still
fails. The same defect shows up under CPU contention on any call, which is why `pnpm test:cross` is a
separate script: a flaky reference must never be able to redden the main suite.

**The reference's run limits are a serde `Duration`.** `max_time` must be `{ secs, nanos }`. Passing a
plain number of nanoseconds does **not** error — deserialization fails quietly and the *default* 1 ms
limit applies, which then times out. It looks exactly like a slow engine.

**`PublicKey.toBytes()` throws** in that build. `toString()` returns `"<algorithm>/<hex>"` and is the
reliable accessor.

**The reference package cannot be imported in Node.** Its entry point does
`import * as wasm from "./biscuit_bg.wasm"`, which Node will not resolve, and its `exports` map has no
`require` condition, so `require.resolve` fails too. `tests/cross/reference.ts` finds the package by
walking up to `node_modules`, reads the `.wasm`, and supplies its imports by hand. Running Node with
`--experimental-wasm-modules` does work, but needing a flag for `pnpm test` is worse.

**A failed corpus download used to poison `samples/` permanently.** `samples.json` was written before
the tokens it names while the "already fetched" guard checked only `samples.json`, so an interrupted
fetch left a directory that every later run skipped as complete — and the tests then failed on missing
files forever. The manifest is now written last, and the guard checks every file it names. Downloads
are also pooled at six with retries, because `raw.githubusercontent.com` resets connections when
several dozen requests arrive at once and surfaces it as a bare `TypeError: fetch failed`.

**`pnpm test` fetches the corpus explicitly, not through `pretest`.** pnpm does not run `pre`/`post`
scripts by default, so a `pretest` hook would silently never fire and the suite would fail on a clean
checkout with missing samples.

## Known deviations from the reference

**Names follow the reference parser, not the specification's prose.** A predicate or variable name
is one or more of `[A-Za-z0-9_:]`, ASCII, with any of them first — so `_m`, `1a` and `::` are names
and `ärger` is not — and a predicate takes at least one term. That is what
`@biscuit-auth/biscuit-wasm` accepts; `tests/grammar-cases.ts` records it and `05-grammar` re-asks the
reference, including for generated names. Versions up to 0.2.0 required a Unicode letter first and
accepted `f()`.

**Regex uses JS `RegExp`, not RE2.** Every corpus pattern matches, but backreferences and lookaround
are accepted where Rust would reject them. Documented, not enforced.

**New blocks are signed with signature payload version 1** unconditionally. Datalog block versions, by
contrast, are computed from content: a block declares the lowest version that can legally carry it.

**Arrays and maps do not trigger the v3.3 feature gate.** The reference's `contains_v3_3_term` flags
only `null` and sets containing `null`, so a block using arrays may legally declare v3.1. This looks
like an upstream oversight and is mirrored deliberately, because matching the reference matters more
than being right here. `03-interop-chains` confirms it empirically.

**WebCrypto Ed25519 is not ZIP-215.** `verifyAsync` inherits the platform's verification rules, and
`verify` those of `@noble/curves`. They agree on every honestly produced signature and on the whole
corpus; they may differ only on deliberately malformed encodings, which neither accepts as a forgery.

**Not implemented:** authorizer snapshots (`AuthorizerSnapshot` / `SnapshotBlock`); run limits on
`query` (the evaluation it reads from is bounded, the query itself is not); a revocation-checking helper, since revocation ids are exposed but comparing them against a
list is left to the caller; and wire-compatible third-party blocks — `thirdPartyRequest()` returns a
plain object rather than the `ThirdPartyBlockRequest` protobuf message, so our own end-to-end
third-party flow works and is tested, but the cross-implementation one does not.

Semi-naive evaluation is not implemented either. The fixpoint re-derives every fact each round; the
index makes that cheap at token scale, but not at request scale with large fact sets.

## Design notes

`docs/webrun-biscuit/` in this repository carries the working documents from the implementation
sessions: how the reference actually works, why `mapbox/pbf` was rejected for the protobuf layer, what
the red-green cycle caught, the corpus findings, and what it took to make random differential testing
actually detect a defect.

## License

MIT — see the repository `LICENSE`.
