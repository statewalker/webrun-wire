import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: "src/index.ts",
    output: { file: "dist/index.js", format: "esm" },
    treeshake: true,
    external: ["@statewalker/webrun-ports", "@statewalker/webrun-streams"],
  },
  {
    input: "src/fetch/index.ts",
    output: { file: "dist/fetch/index.js", format: "esm" },
    treeshake: true,
    external: ["@statewalker/webrun-ports", "@statewalker/webrun-streams"],
  },
]);
