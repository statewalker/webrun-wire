# Random Differential Testing, and What It Took to Make It Bite

_Working document — 13 September 2026_

Hand-written cross-reference cases only find the bugs someone thought to look
for. This note records the move to generated programs — and, more usefully, the
two rounds it took before the generated suite could actually detect a defect.

## 1. A real gap, found immediately

`loadToken` had no root-algorithm parameter: it always verified against
Ed25519. A token minted with a **secp256r1 root key** could not be verified at
all.

The conformance corpus never caught this because `test036_secp256r1` and
`test037` use an **Ed25519 root** whose *next* key is secp256r1. The root itself
is never p256 anywhere in the corpus.

Fixed: `loadToken(bytes, rootPublicKey, rootAlgorithm = 0)` and
`Biscuit.verify(key, algorithm = 0)`. Both algorithms now run end to end and
across the implementation boundary.

That is the argument for cross-testing in one sentence: the corpus tests what
upstream chose to record, not what the API allows a caller to do.

## 2. The suite

`test/cross/04-random-differential.test.ts`, plus `generator.ts`.

- programs are generated from a seeded xorshift32, so any failure is
  reproducible from its seed
- each program is minted by one implementation and authorized by both; **the
  oracle is the other implementation**, nothing is hard-coded about the expected
  verdict
- three shapes per algorithm: reference mints → we authorize; we mint →
  reference authorizes; mixed chains where blocks are appended alternately
- both Ed25519 and secp256r1

## 3. Two rounds of making the generator actually test something

The first version passed everything on the first run. That is not reassuring,
it is a smell. Injected-bug runs found two holes.

### Hole 1: uniform sampling wastes most programs

Sampling facts and checks independently produced ~30% `noMatchingPolicy` —
programs where nothing lines up and the engine barely executes.

Rebuilt so each program is anchored on a (resource, operation, user) scenario
and then deliberately perturbed. Distribution moved to roughly **55% ok / 30%
unauthorized / 15% noMatchingPolicy**, which is where checks nearly pass, rules
nearly fire, and policies nearly match.

### Hole 2: `check all` was indistinguishable from `check if`

Injected a straightforward bug — make `queryMatchAll` stop after the first
matching combination, turning `all` into `any`. A sweep of **1,200 programs
found nothing**.

The reason: the generated authorizer only ever asserted one `resource` fact, so
`check all` had exactly one combination to quantify over. With one combination,
`all` and `if` are the same predicate.

After emitting two or three `resource` facts (and a second `operation`), the
same mutation produces **12 mismatches**.

This is the finding worth keeping from the session: *a random suite that passes
tells you nothing until you have shown it can fail.*

## 4. Mutation results after both fixes

| injected bug | mismatches / 800–1200 programs |
|---|---|
| `check all` stops at the first combination | 12 |
| authorizer trusts every origin | 2 |
| `deny` policy treated as `allow` | 8 |

The trust-boundary mutation only surfaced after blocks were made to sometimes
assert *facts* rather than only checks — before that, origin filtering was never
exercised by a generated program. All three restore to zero.

## 5. Sweep results

| seeds | programs compared | mismatches |
|---|---|---|
| 1,500 | 6,000 | 0 |
| 300 (post-fix generator) | 1,200 | 0 |
| committed suite runs | ~1,500 | 0 |

About 9,000 generated programs in total, both algorithms, both directions, zero
disagreements with the reference.

The committed `ROUNDS = 75` keeps `pnpm test:cross` near 30 seconds. Larger
campaigns are a matter of raising that constant; the generator lives in its own
module precisely so a sweep script can import it.

## 6. Open threads

- **The generator does not cover** closures, maps, third-party blocks or FFI.
  Those remain only in the hand-written cases. Extending the grammar is the
  obvious next increment.
- **`ROUNDS` is small enough** that a rare disagreement could slip through a
  single CI run. The value is in deliberate sweeps, which nothing currently
  schedules.
- **Shrinking is not implemented.** A failure reports its seed and the full
  program text, which is reproducible but not minimal.
- **No CI**, still.
- `biscuit-web-key` remains unexamined; authorizer snapshots remain
  unimplemented.
