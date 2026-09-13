// Self-contained rather than spreading the root config, because this package
// has no `@statewalker/*` dependencies and so needs none of the root's
// workspace-source alias map. What it does need is an `include` narrow enough
// to leave `tests/cross/` out: the root config collects `**/tests/**/*.test.ts`,
// which would sweep the cross-reference suite into every `pnpm test`.
//
// That suite is kept separate deliberately. It drives the reference
// implementation (`@biscuit-auth/biscuit-wasm`), whose build reports spurious
// `RunLimit` timeouts under CPU contention — a flake that must never be able to
// redden the main suite or a turbo build. Run it with `pnpm test:cross`.
//
// Exported as a plain object, not via `defineConfig`, to match the root config.
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["tests/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
};
