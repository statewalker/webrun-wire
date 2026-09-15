---
"@statewalker/webrun-biscuit": minor
---

Parameters, queries, token-less evaluation and WebCrypto verification — the pieces an
application needs to use Biscuit without working around the API.

- **`{name}` parameters** in `Biscuit.build`, `attenuate`, `authorize`, `evaluate` and
  `query` (`options.params`). Values are bound as terms, never spliced into source, so an
  untrusted string cannot change a program's shape. Unbound and unused parameters are a
  `ParseError`, as in the reference.
- **`evaluate(token | null, code, options)`** and `VerifiedBiscuit.evaluate` return the
  result plus `query(rule)` over the evaluated world — the reference's
  `Authorizer::query`, scoped like the authorizer so an attenuation block cannot inject
  what a query reads. `null` evaluates the authorizer's own facts and rules. `snapshot()`
  is computed only on request, so `authorize` no longer prints the whole world on every
  call.
- **Failed checks carry `rule`**, the check as the reference prints it. The conformance
  suite now compares that text against the official corpus, and the random differential
  suite against the reference.
- **`verifyAsync` / `loadTokenAsync`** verify Ed25519 with the platform's WebCrypto where
  available — about eight times faster than `verify` in Node — and fall back to
  `@noble/curves` otherwise. Both paths consume one list of signature checks.

Fixed: variables were written to the wire as parser-local ids instead of interned names,
so the reference printed `$k` as `$write`, and a block with 28 or more distinct variables
produced a token this library could not read back.

`FailedCheck` gains a required `rule` field, and `authorize`/`authorizeDetailed` accept
`null` for the token; code that constructs `FailedCheck` literals must add `rule`.
