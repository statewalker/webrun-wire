import { defineConfig } from "rolldown";
import { externalsFrom } from "../../rolldown.preset.js";

// Single ESM bundle at dist/index.js. `@noble/curves` and `@noble/hashes` are
// declared dependencies and so stay external — see ../../rolldown.preset.js.
export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
  },
  treeshake: true,
  external: externalsFrom(import.meta.url),
});
