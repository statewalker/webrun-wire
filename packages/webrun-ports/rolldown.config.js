import { defineConfig } from "rolldown";
import { externalsFrom } from "../../rolldown.preset.js";

// Single ESM bundle at dist/index.js. Everything this package declares as a
// dependency or peer dependency stays external — see ../../rolldown.preset.js.
export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
  },
  treeshake: true,
  external: externalsFrom(import.meta.url),
});
