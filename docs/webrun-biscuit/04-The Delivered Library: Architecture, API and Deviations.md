# The Delivered Library: Architecture, API and Deviations

_Working document — 12 September 2026_

`biscuit-ts` — a pure TypeScript Biscuit implementation. No WASM, no Node
built-ins in `src/`, two runtime dependencies (`@noble/curves`,
`@noble/hashes`). Runs in Node, browsers, Workers and Durable Objects. The full
source is in the `code/` subfolder of this session folder.

## 1. Why this exists at all

There is **no pure JS/TS Biscuit implementation**. npm has only
`@biscuit-auth/biscuit-wasm` (a Rust→WASM wrapper) and a web-components
package. For browser-first or Durable-Object contexts a WASM blob is a real
cost: bundle size, instantiation, and a platform surface that does not exist
everywhere. That gap is the justification.

## 2. Module map

| file | lines | responsibility |
|---|---|---|
| `src/proto.ts` | 764 | strict proto2 codec |
| `src/datalog.ts` | ~690 | term model, fixpoint engine, expression VM |
| `src/parser.ts` | 581 | Datalog text syntax |
| `src/authorizer.ts` | ~400 | symbol resolution, block loading, authorization |
| `src/builder.ts` | ~390 | minting, attenuation, sealing, third-party blocks |
| `src/print.ts` | 77 | rule pretty-printer for error messages |
| `src/base64.ts` | ~45 | URL-safe base64, runtime-agnostic |
| `src/index.ts` | ~90 | public API |

Roughly 4,100 lines including tests.

## 3. Public API

```ts
const root = generateKeypair();

const token = Biscuit.build(root.secretKey, 'user("alice"); right("file1", "read");')
  .attenuate('check if operation("read");')
  .seal()
  .toBase64();

const verified = Biscuit.fromBase64(token).verify(root.publicKey);
verified.authorize('operation("read"); allow if user("alice");');
// { kind: 'ok', policy: 0 }
```

`verify()` throws on an inauthentic token and returns a `VerifiedBiscuit`; the
type system therefore prevents authorizing an unverified token, which is the
mistake worth designing against.

Third parties sign blocks without holding the token:

```ts
const request  = Biscuit.fromBase64(token).thirdPartyRequest();
const response = thirdPartyBlock(request, externalSecret, 'group("admin");');
const extended = Biscuit.fromBase64(token).appendThirdParty(response);
```

## 4. Test coverage

100 tests, all passing, via `pnpm test`:

| suite | covers |
|---|---|
| `01-proto` | byte-exact round-trip of all 38 tokens, i64 extremes, strict rejection |
| `02-crypto` | signature outcomes and revocation ids for all samples |
| `03-datalog` | engine unit tests ported from the Rust `datalog` module |
| `04-parser` | terms, precedence, closures, scopes |
| `05-conformance` | the upstream corpus — 38 tokens / 50 validations |
| `06-builder` | write path, plus the corpus rebuilt from source |
| `07-api` | base64 and the public facade |
| `08-hardening` | property round-trips, mutation/truncation fuzzing, join scaling |

The corpus is **fetched**, not vendored: `scripts/fetch-samples.mjs` pulls it
from the upstream repo during `pretest`. The samples belong to the biscuit
project and should not be copied into ours.

## 5. Engineering decisions worth remembering

- **Canonical string keys for terms.** JS `Map`/`Set` are reference-keyed;
  Rust relies on derived `Hash`/`Ord` over `BTreeSet`. Every structural
  comparison and every de-duplication in the engine goes through `termKey()`.
- **Symbols resolved to strings at load time** rather than kept as indices.
  Simpler and semantically equivalent.
- **Fact index by `name/arity`**, cached per trusted-origin set and invalidated
  by a generation counter, so a join never scans unrelated predicates.
- **`Uint8Array` everywhere, never `Buffer`** in `src/`, so the library is
  runtime-agnostic. Tests may use Node APIs.

## 6. Known deviations from the reference

| deviation | risk |
|---|---|
| Regex uses JS `RegExp`, not RE2 | backreferences and lookaround are accepted where Rust rejects them; every corpus pattern matches |
| Set ordering follows string order, not symbol-index order | observable only in printing, not in results |
| New blocks always signed with payload version 1 | a hypothetical v0-only verifier would reject our tokens |
| `AuthorizerSnapshot` / `SnapshotBlock` not implemented | cannot serialize or resume authorizer state |

## 7. Open threads

- **Snapshots** are the one item from the roadmap not built. They matter only
  for inspecting or resuming an evaluation; nothing in the current use case
  needs them.
- **The regex question** needs a decision: validate patterns against an RE2
  subset, port a small RE2 matcher, or document the divergence and move on.
  Currently documented, not enforced.
- **Semi-naive evaluation** is not implemented. The fixpoint still re-derives
  every fact each round; the index makes that cheap enough at token scale but
  not at request scale with large fact sets.
- **No published package.** Name, license headers, CI and a browser bundle-size
  budget all still to decide.
- The relationship to the capability plan for httpeers is unexplored in this
  session — whether Biscuit tokens are the capability format there, or whether
  this is a standalone library, has not been discussed.
