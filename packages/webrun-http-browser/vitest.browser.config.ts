// Config for this package's `test:browser` script: Node-side vitest driving
// real Chromium and Firefox through Playwright (see tests/browser/). The
// pages load the BUILT bundles from `dist/`, so the script builds first.
//
// A plain object rather than `defineConfig`, like the repo-root config:
// `defineConfig` is only a typing helper. `--config` replaces the root config,
// which is fine here — these tests import nothing from the workspace.
export default {
  test: {
    environment: "node",
    // `tests/dist/**` was here too, and could never have matched anything:
    // `dist/` is gitignored repo-wide, so a test file under it is invisible to
    // git. The packaging tests live in `tests/packaging/` instead.
    include: ["tests/browser/**/*.browser.ts", "tests/packaging/**/*.dist.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
};
