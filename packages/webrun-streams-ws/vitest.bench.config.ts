// Config for the opt-in `test:bench` script only — never loaded by the
// package's `test` script or by the repo-root `vitest.config.ts` that the
// default `pnpm test` / CI run uses. It re-exports the real root config
// (same aliasing, same environment) and swaps `test.include` to the
// `*.bench.ts` glob, which the shared config deliberately excludes so that
// slow, non-gating measurement harnesses stay out of the default suite.
import base from "../../vitest.config.ts";

export default {
  ...base,
  test: {
    ...base.test,
    include: ["**/tests/**/*.bench.ts"],
  },
};
