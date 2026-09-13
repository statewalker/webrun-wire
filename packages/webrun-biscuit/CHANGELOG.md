# @statewalker/webrun-biscuit

## 0.1.0

### Minor Changes

- 0d8ea0f: Biscuit authorization tokens, in pure TypeScript.

  A new package: the proto2 codec, the Ed25519 and secp256r1 signature chain, the
  Datalog fixpoint engine, the text parser, the authorizer and the token builder.
  Two runtime dependencies (`@noble/curves`, `@noble/hashes`), no WASM and no Node
  built-ins in `src/`, so it runs in Node, browsers, Workers and Durable Objects.

  **Why it exists.** npm carries no other pure JS/TS Biscuit implementation — only
  `@biscuit-auth/biscuit-wasm`, the Rust crate compiled to WebAssembly. For a
  browser-first or Durable-Object context that blob is a real cost: bundle size, an
  instantiation step, and a platform surface that is not available everywhere.

  **Why you can believe it.** A reimplementation of a security primitive is only
  worth having if it demonstrably agrees with the original, so the package carries
  three independent checks. The official corpus (fetched from the specification
  repo at a pinned commit, not vendored) covers 38 tokens and 50 validations, and
  `09-world-snapshot` compares the entire post-run world per origin — catching
  rule-evaluation errors that do not change the verdict. A cross-reference suite
  runs against the reference implementation itself in both directions, including
  generated programs where the reference is the oracle rather than a hard-coded
  expectation. And `pnpm mutate` injects ten known defects and requires the suite
  to catch each; all ten are caught.

  The deprecated v1/v2 corpora are fetched as negative fixtures: every block
  declares a Datalog version, and a v2 token that verifies cleanly is a
  vulnerability rather than a compatibility nicety.

  Known deviations are documented in the README — JS `RegExp` rather than RE2,
  looser default run limits than the reference, and the reference's own
  arrays/maps feature-gate quirk, mirrored deliberately because matching it
  matters more than being right there. Authorizer snapshots, a `query(rule)` API
  and wire-compatible third-party blocks are not implemented.
