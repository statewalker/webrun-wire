/**
 * The BUILT declarations compile with the DOM lib alone.
 *
 * A page, or a library that serves pages and workers (cellb), compiles without TypeScript's
 * WebWorker lib, where `ServiceWorkerGlobalScope` and `FetchEvent` live. A public type that names
 * them makes every such consumer fail to compile against `dist/sw.d.ts` (unless it skips lib
 * checks): the ServiceWorker-facing API takes them structurally (`ServiceWorkerScope`,
 * `FetchEventLike`). This compiles a consumer of each entry with `lib: ["dom", "es2022"]`.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("../../", import.meta.url));
const tsc = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));
let dir: string | undefined;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the built declarations need no WebWorker lib", () => {
  it("each entry's types compile with lib dom + es2022", async () => {
    dir = await mkdtemp(join(tmpdir(), "webrun-http-browser-types-"));
    const entries = ["index", "sw", "worker"];
    await writeFile(
      join(dir, "consumer.ts"),
      `${entries.map((e) => `import type * as ${e} from "${join(pkg, "dist", `${e}.js`)}";`).join("\n")}
export type Used = [${entries.map((e) => `typeof ${e}`).join(", ")}];
`,
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["dom", "dom.iterable", "es2022"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["consumer.ts"],
      }),
    );
    let output = "";
    try {
      execFileSync(tsc, ["-p", dir], { stdio: "pipe" });
    } catch (error) {
      output = String((error as { stdout?: Buffer }).stdout ?? error);
    }
    expect(output).toBe("");
  }, 120_000);
});
