# Evaluating mapbox/pbf for the Protobuf Layer

_Working document — 12 September 2026_

Mikhail proposed `mapbox/pbf` as the protobuf layer for a TypeScript Biscuit
implementation. It was tested against the real schema and the real corpus
rather than judged from its README. The conclusion changed twice during the
session; both positions are recorded.

## 1. Why it looked right

2.5 KB gzipped, zero dependencies, ESM, ships `index.d.ts`, splits
`PbfReader`/`PbfWriter` so bundlers drop the unused half. Its codegen compiled
biscuit's `schema.proto` cleanly into 66 readable functions. Decoding all 38
sample tokens worked immediately.

## 2. Four defects found by testing, not reading

| # | defect | consequence |
|---|---|---|
| 1 | `oneof` is not modelled on the write side | a `variable` term re-encodes as variable + integer 0 + string 0 + bool false; Rust takes the last field, so the variable silently becomes `bool(false)` |
| 2 | zero-valued required fields are dropped (`if (obj.kind)`) | every Ed25519 key (`algorithm = 0`) and every `LessThan` operator encodes malformed |
| 3 | `readVarint` returns a JS `Number` | i64::MAX decodes as `9223372036854776000`; `test027_integer_wraparound` contains exactly that value |
| 4 | proto2 `optional` presence is not tracked | absent fields re-encode as explicit zeros, breaking byte-exactness |

Defect 3 is the serious one. A 10-line BigInt varint reader over `pbf.buf` /
`pbf.pos` recovers i64::MAX and i64::MIN exactly; `readVarint(true)` cannot.

Defect 2 and 4 interact: `Check.kind` is `optional` while `OpBinary.kind` is
`required`, so presence has to be decided per field from the schema, never by
field name.

## 3. It can be made to work

With four targeted patches — oneof-aware writers, `!= null` for required
fields, BigInt for the two integer fields, `undefined` defaults for optionals —
a byte-exact round-trip over the whole corpus succeeds:

- **tokens: 38/38 byte-identical**
- **blocks: 63/65** — the two failures are `test003_invalid_signature_format`
  and `test004_random_block`, which are deliberately corrupt, so that is the
  correct outcome

## 4. The position that changed

Initial recommendation: keep pbf as the byte layer (varints, buffer growth) and
hand-write the message layer, checking the patched codegen output into the repo
rather than regenerating.

Final decision during implementation: **drop pbf entirely.** Once BigInt
varints, proto2 presence tracking, strict UTF-8 validation and unknown-field
rejection were all required, pbf was contributing only buffer growth — about 40
lines. The hand-rolled strict codec is 764 lines and owns its own invariants.

The earlier reasoning was not wrong, it was incomplete: it weighed pbf against
"a protobuf library" rather than against "the codec this security-sensitive
format actually needs".

## 5. Two security notes that drove the decision

- `readString()` decodes UTF-8 lossily (replacement characters). A token parser
  should reject invalid input, not absorb it. Ours uses
  `TextDecoder('utf-8', { fatal: true })`.
- pbf enforces nothing: missing `required` fields become `undefined`, unknown
  fields are skipped silently, duplicate fields overwrite. A token with no
  `authority` and no `proof` decodes "fine". Our codec rejects all of these.

## 6. Open threads

- If bundle size ever becomes the binding constraint, the hand-rolled codec is
  the first place to look — it could shrink by generating only the read path
  for verify-only builds.
- The patched pbf experiment still exists as a reference point if the
  hand-rolled codec ever needs cross-checking against an independent
  implementation of the same schema.
