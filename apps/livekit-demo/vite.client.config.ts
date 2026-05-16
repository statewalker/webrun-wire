import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const swRuntime = fileURLToPath(
  new URL("./node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js", import.meta.url),
);

function serveSwWorker() {
  return {
    name: "serve-sw-worker",
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          fn: (
            req: unknown,
            res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void },
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use("/sw-worker.js", (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Service-Worker-Allowed", "/");
        res.end(readFileSync(swRuntime));
      });
    },
    writeBundle(options: { dir?: string }) {
      const dest = resolve(options.dir ?? "dist", "sw-worker.js");
      copyFileSync(swRuntime, dest);
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL("./client-page", import.meta.url)),
  plugins: [serveSwWorker()],
  base: "./",
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist/client-page", import.meta.url)),
    emptyOutDir: true,
  },
  server: { port: 5276 },
});
