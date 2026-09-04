import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

/**
 * Vitest global setup: run a PeerJS broker for the browser suite.
 *
 * PeerJS peers cannot find each other without a signalling broker, and the
 * public cloud broker is not something a test suite should depend on — it
 * would make every run require internet access and someone else's uptime.
 * `peer` (the reference PeerServer) is already a devDependency, so the suite
 * brings its own on a loopback port.
 *
 * This runs in Node while the tests run in the browser, so the port is handed
 * across with `provide`/`inject`.
 *
 * The broker runs in a **child process**, not in-process. Hosted in-process it
 * keeps the run alive after the last test: `close()` stops the listener but
 * waits on the browser's long-lived WebSockets, and `peer` also holds its own
 * client-expiry timers with no public way to clear them. The suite then goes
 * green and hangs, which in CI is indistinguishable from a timeout. A child
 * process is torn down by killing it, which has no such failure mode.
 */

declare module "vitest" {
  interface ProvidedContext {
    peerServerPort: number;
  }
}

/** Ask the OS for a free port, then close the probe and hand the number on. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("could not obtain a loopback port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const BROKER_START_TIMEOUT_MS = 15_000;

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort();
  const packageDir = fileURLToPath(new URL("../", import.meta.url));

  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { PeerServer } = require("peer");
       PeerServer({ port: ${port}, path: "/webrun", host: "127.0.0.1" }, () => {
         process.stdout.write("READY\\n");
       });`,
    ],
    { cwd: packageDir, stdio: ["ignore", "pipe", "pipe"] },
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`PeerServer did not start within ${BROKER_START_TIMEOUT_MS}ms`));
    }, BROKER_START_TIMEOUT_MS);

    let stderr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.stdout?.on("data", (buf: Buffer) => {
      if (buf.toString().includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`PeerServer exited early (code ${code}): ${stderr.trim()}`));
    });
  });

  project.provide("peerServerPort", port);

  return async () => {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    }
  };
}
