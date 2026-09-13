# Repository Manifest: What Is in code/ and How to Run It

_Working document — 12 September 2026_

The `code/` subfolder of this session folder holds the complete `biscuit-ts`
project, one Drive file per source file, in the same layout as the working
repository. Nothing is compressed or concatenated.

## 1. To run it

Download `code/` to a local directory, then:

```bash
pnpm i
pnpm test
```

Expected: **100 tests, 0 failures.** Verified from a clean directory with no
`node_modules` and no `samples/`.

`pretest` runs `scripts/fetch-samples.mjs`, which downloads the 38 upstream
conformance tokens plus `samples.json` from the biscuit repository into
`samples/`. That directory is therefore absent from `code/` by design — the
corpus belongs to the biscuit project and is fetched, not vendored. Network
access to `raw.githubusercontent.com` is required for the first run.

One rename to undo: `gitignore.txt` should become `.gitignore` locally. Drive
does not accept leading-dot filenames.

## 2. Full file listing

```
code/
├── package.json              pnpm scripts, deps, exports map
├── tsconfig.json             strict, ES2022, NodeNext
├── tsconfig.build.json       declaration emit into dist/
├── gitignore.txt             → rename to .gitignore
├── README.md                 usage, layout, known deviations
├── scripts/
│   └── fetch-samples.mjs     downloads the upstream corpus
├── src/
│   ├── proto.ts              strict proto2 codec (764 lines)
│   ├── crypto.ts             signature chain, Ed25519 + secp256r1
│   ├── datalog.ts            term model, fixpoint engine, expression VM
│   ├── parser.ts             Datalog text syntax
│   ├── print.ts              rule pretty-printer for error messages
│   ├── authorizer.ts         symbol resolution, block loading, authorization
│   ├── builder.ts            mint, attenuate, seal, third-party blocks
│   ├── base64.ts             URL-safe base64, runtime-agnostic
│   └── index.ts              public API — Biscuit, VerifiedBiscuit
└── test/
    ├── 01-proto.test.ts      byte-exact round-trip, i64 extremes, strict rejection
    ├── 02-crypto.test.ts     signature outcomes, revocation ids
    ├── 03-datalog.test.ts    engine tests ported from the Rust suite
    ├── 04-parser.test.ts     terms, precedence, closures, scopes
    ├── 05-conformance.test.ts  upstream corpus: 38 tokens / 50 validations
    ├── 06-builder.test.ts    write path + corpus rebuilt from source
    ├── 07-api.test.ts        base64 and the public facade
    └── 08-hardening.test.ts  property round-trips, fuzzing, join scaling
```

23 files, roughly 4,100 lines.

## 3. Dependency order

Useful if reading rather than running. Each module depends only on the ones
above it:

| layer | modules |
|---|---|
| 0 | `base64`, `proto` |
| 1 | `crypto` (needs `proto` types), `datalog` |
| 2 | `parser`, `print` (need `datalog`) |
| 3 | `authorizer` (needs all of the above) |
| 4 | `builder` (needs `authorizer` for the parser entry point) |
| 5 | `index` |

The one awkward edge: `builder` imports `parseAuthorizer` and `DEFAULT_SYMBOLS`
from `authorizer`. That is a naming artefact rather than a real layering
problem — both are block-level concerns that happen to live in the authorizer
module. Worth moving to a `symbols.ts` if the file grows.

## 4. Test counts by suite

| suite | tests |
|---|---|
| 01-proto | 4 |
| 02-crypto | 2 |
| 03-datalog | 14 |
| 04-parser | 10 |
| 05-conformance | 51 (50 validations + a coverage guard) |
| 06-builder | 9 |
| 07-api | 4 |
| 08-hardening | 6 |
| **total** | **100** |

## 5. Open threads

- **`.gitignore` rename** is a manual step. If this becomes a real repository
  rather than a Drive snapshot, that goes away.
- **No CI.** Nothing runs the suite on change; the fetch step makes the corpus
  a network dependency, which a CI cache would want to handle.
- **No published package.** `package.json` names it `biscuit-ts` at `0.1.0`
  with an Apache-2.0 licence field, but no `LICENSE` file exists yet and the
  name is not claimed on npm.
- **`samples/` is fetched from `main`**, not a pinned commit. The script has a
  `REF` constant for exactly this; it should be set to a tag or SHA before the
  suite is relied on for regression testing, otherwise an upstream change to
  the corpus can turn the build red for reasons unrelated to this code.
