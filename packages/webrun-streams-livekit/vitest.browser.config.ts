// Browser-mode config for this package's `test:browser` script. It exists
// separately from the repo-root `vitest.config.ts` because `vitest run
// --config <file>` replaces the root config entirely rather than merging with
// it — so the workspace source aliases have to be restated here.
//
// Exported as a plain object, for the same reason the root config is: this
// file is loaded from a package directory whose `node_modules` does not
// necessarily resolve "vitest/config" for the loader. `defineConfig` is only
// a typing helper.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";

// Resolve every `@statewalker/webrun-*` workspace import to its TypeScript
// source, mirroring the root `vitest.config.ts` and `tsconfig.base.json`'s
// `paths`. Without it the package `exports` maps send vitest to `dist/`, and
// the browser suite would silently test the last build rather than the tree.
const packagesUrl = new URL("../", import.meta.url);

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
    include: ["tests/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
};
