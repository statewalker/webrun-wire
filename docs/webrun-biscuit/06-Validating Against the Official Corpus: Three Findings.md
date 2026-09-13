# Validating Against the Official Corpus: Three Findings

_Working document — 12 September 2026_

The implementation was first validated against the sample corpus vendored in
`biscuit-rust`. Mikhail then pointed at the **specification repository**,
[`eclipse-biscuit/biscuit`](https://github.com/eclipse-biscuit/biscuit), as the
thing to conform to. That was the right instinct: it surfaced three problems,
one of them a genuine vulnerability.

This note supersedes the claim in note 04 that conformance was complete.

## 1. The corpus we had been using was not canonical

`schema.proto` is byte-identical between the spec repo and `biscuit-rust`. The
**samples are not**:

| file | status |
|---|---|
| `samples.json` | differs |
| `test034_array_map.bc` | differs (1953 vs 2010 bytes) |
| the other 37 tokens | identical |

The implementation's copy carries an extra check —
`check if [1, 2].get(-1) == null;` — that the specification's copy does not.
Expected results agree; only the content drifted.

**Lesson:** the corpus belongs to the spec repository. An implementation's
vendored copy is a snapshot, and snapshots drift. The fetcher now pulls from
`eclipse-biscuit/biscuit@b3d3fe2/samples/current`, pinned.

All 100 pre-existing tests passed against the canonical corpus unchanged, so
the drift was not masking a bug — but it could have.

## 2. We were only checking the verdict, not the world

Each validation in `samples.json` records a `world` snapshot: the **post-run**
state, with every fact grouped by origin, plus rules, checks and policies as
printed strings.

```json
{
  "facts": [
    { "origin": [null], "facts": ["operation(\"read\")", "resource(\"file2\")"] },
    { "origin": [0],    "facts": ["owner(\"alice\", \"file1\")"] }
  ],
  "rules":  [{ "origin": 1, "rules": ["right($0, \"read\") <- resource($0), ..."] }],
  "policies": ["allow if true"]
}
```

We had been comparing only the policy outcome and the failed-check list. That
is much weaker: a rule that derives the *wrong* facts passes if the final
verdict happens to match anyway. `test007_scoped_rules` is precisely such a
case — its whole point is that a scoped rule derives **nothing**.

Implementing the comparison required finishing the pretty-printer. First run:
33 of 44. Three real bugs:

| bug | detail |
|---|---|
| authorizer origin is asymmetric | in `facts` groups it serializes as `null`; in `rules` and `checks` groups it is the raw `u64::MAX` (`18446744073709552000` once through JSON) |
| string literals are not JSON | `"hello é\t😁"` prints with a **literal** tab. Only `"` and `\` are escaped in Datalog; `JSON.stringify` escapes control characters |
| closure parameters lost their names | variable names were collected from predicate terms only, so `$p` in `.all($p -> $p > 0)` printed as `$1025` |

All 44 snapshots now match exactly.

## 3. Block versions were ignored — a real vulnerability

The deprecated corpora found this. Running them through the loader before the
fix:

| corpus | result |
|---|---|
| v1 (19 tokens) | 0 decoded — different wire format, correctly rejected |
| v2 (21 tokens) | **16 accepted as valid** |

Every block carries a `version` field declaring the Datalog version it was
generated at. We were not reading it. The reference enforces
`MIN_SCHEMA_VERSION = 3 … MAX_SCHEMA_VERSION = 6`, so those 16 v2 tokens must
fail — and a hypothetical v7 token would also have been accepted.

There is a second layer: **feature gates**. A block must not use a feature newer
than the version it declares, or a token can smuggle newer semantics past an
older verifier.

| feature | minimum version |
|---|---|
| scopes, bitwise ops, strict `!==`, `check all` | v3.1 (4) |
| third-party blocks | v3.2 (5) |
| `null`, closures, heterogeneous `==` / `!=`, `.type()`, FFI, `reject if` | v3.3 (6) |

Transcribed from `get_schema_version` and `check_compatibility` into
`src/version.ts`, wired into both directions:

- `loadToken` validates every block on decode.
- the builder now **computes** the declared version from content. The previous
  heuristic emitted 3 or 6, which would have produced blocks declaring 3 while
  using scopes — invalid by the rules we had just implemented.

One quirk mirrored deliberately: the reference's `contains_v3_3_term` flags only
`null` and sets containing `null` — **not** arrays or maps. So a block using
arrays may legally declare v3.1. That looks like an upstream oversight, but
matching the reference matters more than being right here.

## 4. What the spec repo contains that we do not implement

| path | status |
|---|---|
| `samples/current` | fully conformant, 38 tokens / 50 validations, worlds included |
| `samples/deprecated/v1`, `v2` | used as negative fixtures — must be rejected |
| `schema.proto` | fully implemented, byte-exact round-trip |
| `SPECIFICATIONS.md` | implemented, minus snapshots |
| `biscuit-web-key/` | **not implemented** — BWK, the JWK-equivalent key format, a separate spec |
| `experimentations/` | not applicable — PoCs for pairing, VRF, gamma signatures, an old Datalog prototype |

## 5. Open threads

- **`biscuit-web-key`** is unexamined. If tokens ever need key distribution
  over HTTP, that is the format to read.
- **Upstream reports worth filing:** the arrays/maps gap in
  `contains_v3_3_term`; the hardcoded block id `0` in `InvalidBlockRule`; and
  the corpus drift between the spec repo and `biscuit-rust`.
- **The spec does not state** that verifiers must accept high-S ECDSA
  signatures — we only learned it from a sample. Also worth raising.
- **Snapshots** (`AuthorizerSnapshot` / `SnapshotBlock`) remain the one
  unimplemented part of the format.
- **No differential testing** against `biscuit-wasm` on random tokens. The
  corpus plus fuzzing covers a lot, but not the space between "the 38 samples"
  and "arbitrary valid tokens".
