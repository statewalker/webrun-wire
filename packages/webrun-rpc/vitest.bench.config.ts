// Config for this package's `bench` script: the benchmarks under `bench/`,
// which compare a windowed link against the same link with no window in one
// run. They are kept out of `test` (the root config takes `tests/**/*.test.ts`
// only) so that a loaded machine cannot fail the normal suite. The root
// config's aliases are kept, so the benchmarks run against the source.
import root from "../../vitest.config.ts";

export default {
  ...root,
  test: {
    ...root.test,
    include: ["bench/**/*.bench.ts"],
    // One benchmark at a time: two in parallel would measure each other.
    fileParallelism: false,
    testTimeout: 600_000,
    // The numbers are the point: print them, passing or not.
    silent: false,
  },
};
