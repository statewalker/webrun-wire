// The cross-reference suite: our implementation against the reference one
// (`@biscuit-auth/biscuit-wasm`, the Rust crate compiled to WASM). Separate
// from vitest.config.ts so `pnpm test` never depends on it — see the comment
// there for why.
//
// The timeout is generous because `04-random-differential` mints and authorizes
// ~1,500 generated programs through both implementations in a single test, and
// because the reference's first `authorize` call on any Authorizer reports a
// spurious timeout that `referenceOutcome` absorbs by retrying.
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["tests/cross/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
};
