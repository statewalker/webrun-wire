import { defineConfig } from "rolldown";
import { externalsFrom } from "../../rolldown.preset.js";

// Three entry points, because two of them touch a platform: `./node` writes a
// file, `./browser` writes `localStorage`. The root is neither and runs in
// both, which is the whole reason they are split rather than branched on at
// runtime.
export default defineConfig({
  input: {
    index: "src/index.ts",
    node: "src/node.ts",
    browser: "src/browser.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
  },
  treeshake: true,
  external: externalsFrom(import.meta.url),
});
