// Browser-to-browser e2e for p2p-demo: boots the relay + both Vite dev
// servers exactly as scripts/start.sh does, opens the server page and the
// client page in one real browser (Chromium or Firefox, via Playwright),
// and asserts that the client discovers the server's service over
// relay -> circuit -> WebRTC and mounts it.
//
// This is the only check in the libp2p-3.x-and-identity change that proves
// two browsers actually find each other after gossipsub was ripped out and
// replaced with relay-based discovery. A green unit-test suite or build
// says nothing about that — only this does. Do not weaken the assertions
// below to make a run pass.
//
// Usage:
//   E2E_BROWSER=chromium node e2e/browser-to-browser.mjs
//   E2E_BROWSER=firefox  node e2e/browser-to-browser.mjs

import { spawn } from "node:child_process";
import { chromium, firefox } from "playwright";

const BROWSER = process.env.E2E_BROWSER ?? "chromium";
const engines = { chromium, firefox };
const engine = engines[BROWSER];
if (!engine) throw new Error(`unknown E2E_BROWSER: ${BROWSER}`);

const procs = [];
let stopped = false;
function stopAll() {
  if (stopped) return;
  stopped = true;
  for (const p of procs) {
    // pnpm run <script> spawns a further child (tsx, vite) that does not
    // reliably die just because the pnpm process gets a SIGTERM. Each
    // process below is started detached in its own process group
    // (`detached: true`), so signal the whole group via the negative pid
    // — this is what actually reaches the grandchild.
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      // already dead
    }
    try {
      p.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
}
process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(1);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(1);
});

function run(cmd, args, env) {
  const p = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  procs.push(p);
  return p;
}

async function relayMultiaddr() {
  const p = run("pnpm", ["run", "relay"], { RELAY_PORT: "9090" });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay printed no multiaddr in 60s")), 60_000);
    const onData = (buf) => {
      const m = String(buf).match(/\/ip4\/[^\s]+\/p2p\/[A-Za-z0-9]+/);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("exit", (c) => {
      clearTimeout(t);
      reject(new Error(`relay exited early: ${c}`));
    });
  });
}

async function waitForHttp(url, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function log(msg) {
  console.log(`[${BROWSER}] ${msg}`);
}

const multiaddr = await relayMultiaddr();
log(`relay multiaddr: ${multiaddr}`);
const env = { VITE_RELAY_MULTIADDR: multiaddr, VITE_GROUP_ID: "e2e" };
run("pnpm", ["run", "server-page"], env);
run("pnpm", ["run", "client-page"], env);
await waitForHttp("http://localhost:5175");
await waitForHttp("http://localhost:5176");
log("relay + both dev servers are up");

const browser = await engine.launch();
const ctx = await browser.newContext();
const errors = [];
const serverPage = await ctx.newPage();
const clientPage = await ctx.newPage();
for (const [name, page] of [
  ["server", serverPage],
  ["client", clientPage],
]) {
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name} console: ${m.text()}`);
  });
}

let exitCode = 1;
try {
  await serverPage.goto("http://localhost:5175/#e2e");
  await clientPage.goto("http://localhost:5176/#e2e");

  // Wait for each page to actually report its own peer id, so failures
  // downstream can be pinned to "never came up" vs. "came up but never
  // discovered the other peer".
  const serverPeerLoc = serverPage.locator("#peer-id");
  const clientPeerLoc = clientPage.locator("#peer-id");
  await serverPeerLoc.waitFor({ state: "visible", timeout: 30_000 });
  await clientPeerLoc.waitFor({ state: "visible", timeout: 30_000 });
  const serverSynth = (await serverPeerLoc.textContent())?.trim();
  const serverPeerId = await serverPeerLoc.getAttribute("title");
  const clientSynth = (await clientPeerLoc.textContent())?.trim();
  const clientPeerId = await clientPeerLoc.getAttribute("title");
  log(`server page peer: ${serverSynth} (${serverPeerId})`);
  log(`client page peer: ${clientSynth} (${clientPeerId})`);

  // Exact match on the button's textContent: client-page/main.ts renders
  // one button per service row, text "Mount" while state === "available"
  // and "Unmount" otherwise. A substring/case-insensitive match like
  // text=/Mount/i also matches "Unmount" and would give a false pass on a
  // client that never discovered anything to mount.
  const svcRow = clientPage.locator("#services li.svc-row").first();
  const mount = clientPage.getByRole("button", { name: "Mount", exact: true });
  await mount.waitFor({ state: "visible", timeout: 90_000 });

  const svcTitle = (await svcRow.locator(".svc-title").textContent())?.trim();
  const svcFromCode = svcRow.locator(".svc-from code");
  const remoteSynth = (await svcFromCode.textContent())?.trim();
  const remotePeerId = await svcFromCode.getAttribute("title");
  log(`discovered service "${svcTitle}" from remote peer ${remoteSynth} (${remotePeerId})`);

  if (remotePeerId !== serverPeerId) {
    throw new Error(
      `discovered service's remote peer (${remotePeerId}) does not match the server page's ` +
        `own peer id (${serverPeerId}) — this is not proof the client discovered the server`,
    );
  }

  await mount.click();

  // Assert against an iframe that actually lives inside a mounted service
  // card, not just "the page's first iframe" — a page.locator("iframe")
  // could match anything and would pass even if the mount silently failed
  // to render into #mounts.
  const mountedIframe = clientPage.locator("#mounts .mount-card .mount-iframe").first();
  await mountedIframe.waitFor({ state: "attached", timeout: 60_000 });

  const mountCount = await clientPage.locator("#mounts .mount-card").count();
  log(`mounted ${mountCount} service card(s) in #mounts`);

  log(`PASS — client discovered ${remoteSynth}'s "${svcTitle}" service and mounted it`);
  exitCode = 0;
} catch (err) {
  log(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (errors.length) {
    log(`page errors:\n  ${errors.join("\n  ")}`);
  }
  await browser.close();
  stopAll();
}

process.exit(exitCode);
