// Exported as a plain object rather than via `defineConfig` from "vitest/config".
// This file is loaded by every package's `vitest run`, but the repo root is not
// itself a workspace package, so it has no node_modules and an import of
// "vitest/config" cannot resolve from here — which made every package's test
// script fail with ERR_MODULE_NOT_FOUND. `defineConfig` is only a typing
// helper, so dropping it costs nothing and makes this config resolvable from
// any package.

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve every `@statewalker/webrun-*` workspace import to its TypeScript
// source, mirroring the `paths` map in tsconfig.base.json.
//
// Without this, the packages' `exports` maps would send vitest to
// `dist/index.js`: tests would silently run against the last build instead of
// the working tree, so an edit to `src` could stay green while being broken —
// or fail confusingly before the first build. Published consumers still get
// `dist`; only the workspace's own tooling short-circuits to `src`.
const packagesUrl = new URL("./packages/", import.meta.url);

const alias = readdirSync(fileURLToPath(packagesUrl)).flatMap((name) => {
  const srcUrl = new URL(`${name}/src/`, packagesUrl);
  if (!existsSync(new URL("index.ts", srcUrl))) return [];
  const specifier = `@statewalker/${name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const srcDir = fileURLToPath(srcUrl);
  return [
    // Subpath first: the more specific pattern has to win.
    { find: new RegExp(`^${specifier}/(.+)$`), replacement: `${srcDir}$1.ts` },
    { find: new RegExp(`^${specifier}$`), replacement: `${srcDir}index.ts` },
  ];
});

export default {
  resolve: { alias },
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
};
