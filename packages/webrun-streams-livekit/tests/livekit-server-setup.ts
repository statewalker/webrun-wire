import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { TestProject } from "vitest/node";

/**
 * Vitest global setup: run a LiveKit server for the browser suite, and mint
 * the two access tokens the peers join with.
 *
 * The suite previously required `WEBRUN_STREAMS_LIVEKIT_*` environment
 * variables pointing at a server someone else had to run, which meant it never
 * ran. `livekit-server --dev` is a single binary with well-known development
 * credentials (`devkey` / `secret`), so the suite can bring its own the way the
 * PeerJS suite brings its own broker.
 *
 * If the binary is absent the setup throws with an install hint rather than
 * failing obscurely inside the browser; `test:browser` for this package
 * genuinely needs it.
 *
 * This runs in Node while the tests run in the browser, so the URL and tokens
 * are handed across with `provide`/`inject`.
 */

declare module "vitest" {
  interface ProvidedContext {
    livekitUrl: string;
    livekitTokenCaller: string;
    livekitTokenResponder: string;
    livekitRoom: string;
  }
}

const DEV_API_KEY = "devkey";
const DEV_API_SECRET = "secret";
const START_TIMEOUT_MS = 30_000;

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

/** Poll the server's health endpoint until it answers or we run out of time. */
async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      // Any HTTP answer means the listener is up; LiveKit returns 200 "OK".
      if (res.status > 0) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`livekit-server did not become healthy in ${START_TIMEOUT_MS}ms: ${lastError}`);
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort();
  // Every port has to be allocated, not just the signalling one. LiveKit's RTC
  // ports default to a fixed 7881/tcp and 7882/udp, so a second run — or a
  // stray server from an earlier one — dies at startup with "bind: address
  // already in use". That reaches the browser as an opaque connect timeout, so
  // it is worth removing rather than diagnosing twice.
  //
  // The CLI exposes only `--udp-port`, so the rest goes through `--config-body`,
  // which takes the whole config as YAML. Supplying `keys` explicitly is what
  // `--dev` would otherwise do for us.
  const tcpPort = await freePort();
  const udpPort = await freePort();

  const config = [
    `port: ${port}`,
    "bind_addresses:",
    "  - 127.0.0.1",
    "rtc:",
    `  tcp_port: ${tcpPort}`,
    `  udp_port: ${udpPort}`,
    "  use_external_ip: false",
    "keys:",
    `  ${DEV_API_KEY}: ${DEV_API_SECRET}`,
    "logging:",
    "  level: error",
  ].join("\n");

  const child = spawn("livekit-server", ["--config-body", config, "--node-ip", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (buf: Buffer) => {
    stderr += buf.toString();
  });
  // livekit-server logs to stdout, so a diagnostic built from stderr alone is
  // empty exactly when it is most needed.
  child.stdout?.on("data", (buf: Buffer) => {
    stderr += buf.toString();
  });
  child.once("error", (err) => {
    stderr += `\nspawn failed: ${err.message}`;
  });

  // Scoped to startup only. A promise that rejects on *any* exit would still
  // be pending after startup succeeds, and killing the child at teardown would
  // then reject it with nobody awaiting — an unhandled rejection that fails the
  // run after every test has already passed.
  let startupOver = false;
  const exitedDuringStartup = new Promise<never>((_resolve, reject) => {
    child.once("exit", (code) => {
      if (startupOver) return;
      reject(
        new Error(
          `livekit-server exited early (code ${code}). Install it from ` +
            `https://docs.livekit.io/home/self-hosting/local/ — output:\n${stderr.trim()}`,
        ),
      );
    });
  });
  // Nothing awaits this once startup is over; claim the rejection either way.
  exitedDuringStartup.catch(() => {});

  try {
    await Promise.race([waitHealthy(port), exitedDuringStartup]);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  } finally {
    startupOver = true;
  }

  // Tokens are minted here, in Node: the signing secret must never reach the
  // browser bundle, and `livekit-server-sdk` is a Node package.
  const { AccessToken } = await import("livekit-server-sdk");
  const room = `webrun-conformance-${Date.now().toString(36)}`;

  const mint = async (identity: string): Promise<string> => {
    const token = new AccessToken(DEV_API_KEY, DEV_API_SECRET, { identity, ttl: "1h" });
    token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
    return token.toJwt();
  };

  project.provide("livekitUrl", `ws://127.0.0.1:${port}`);
  project.provide("livekitRoom", room);
  project.provide("livekitTokenCaller", await mint("caller"));
  project.provide("livekitTokenResponder", await mint("responder"));

  return async () => {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    }
  };
}
