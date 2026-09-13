import { defineConfig } from "rolldown";
import { externalsFrom } from "../../rolldown.preset.js";

// One entry. The platform-specific route stores left with the router: what
// remains touches no filesystem and no browser storage.
export default defineConfig({
  input: "src/index.ts",
  output: { file: "dist/index.js", format: "esm" },
  treeshake: true,
  external: externalsFrom(import.meta.url),
});
