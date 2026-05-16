import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./server-page", import.meta.url)),
  base: "./",
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist/server-page", import.meta.url)),
    emptyOutDir: true,
  },
  server: { port: 5175 },
});
