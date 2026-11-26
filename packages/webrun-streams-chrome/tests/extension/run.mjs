// Opt-in browser test: `pnpm --filter @statewalker/webrun-streams-chrome test:extension`.
//
// Builds a test extension (service worker broker, content script relay, page
// client), loads it into Playwright's Chromium and runs, through a real
// chrome.runtime.Port and MessagePort: request/response, an event stream
// cancelled by `break`, a streamed fetch of several MiB both ways, and a
// service worker stopped under load. Needs Playwright's Chromium (the full
// browser, `channel: "chromium"`: the headless shell loads no extensions) and
// the workspace built (`pnpm -r run build`). Not part of `pnpm test` / CI.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "rolldown";

const here = fileURLToPath(new URL(".", import.meta.url));
const SIZE = Number(process.env.WEBRUN_CHROME_SIZE ?? 5 * 1024 * 1024);
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

const work = await mkdtemp(join(tmpdir(), "webrun-streams-chrome-"));
const extDir = join(work, "ext");
const wwwDir = join(work, "www");
for (const [entry, dir, file] of [
  ["worker.js", extDir, "worker.js"],
  ["content.js", extDir, "content.js"],
  ["page.js", wwwDir, "page.js"],
]) {
  await build({
    input: join(here, "src", entry),
    platform: "browser",
    logLevel: "warn",
    output: { file: join(dir, file), format: "iife" },
  });
}
await copyFile(join(here, "manifest.json"), join(extDir, "manifest.json"));
await writeFile(
  join(wwwDir, "index.html"),
  '<!doctype html><meta charset="utf-8"><title>webrun-streams-chrome</title><script src="page.js"></script>',
);

const server = createServer(async (req, res) => {
  const name = req.url === "/" ? "index.html" : req.url?.slice(1);
  try {
    const body = await readFile(join(wwwDir, name ?? ""));
    res.writeHead(200, { "content-type": name?.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(join(work, "profile"), {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let failed = false;
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  log("service worker", worker.url());
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.webrunTest !== undefined);

  const rr = await page.evaluate(() => window.webrunTest.requestResponse());
  log("request/response", rr);
  assert.deepEqual(rr, { sum: 5, echoed: true, parallel: true });

  const events = await page.evaluate(() => window.webrunTest.eventsBreak());
  log("event stream, break", events);
  assert.deepEqual(events.ticks, [0, 1, 2, 3, 4]);
  assert.equal(events.stats.eventsOpen, 0, "the worker's generator ran its finally");
  assert.equal(events.stats.eventsFinally, 1);
  assert.equal(events.ports, 1, "only the methods port is left on the mux");

  const fetched = await page.evaluate((size) => window.webrunTest.streamedFetch(size), SIZE);
  log(`streamed fetch, ${SIZE} bytes`, fetched);
  assert.equal(fetched.ok, true, "every downloaded byte");
  assert.equal(fetched.echoOk, true, "every echoed byte");

  await page.evaluate(() => window.webrunTest.startPending());
  await new Promise((r) => setTimeout(r, 500));
  const cdp = await context.newCDPSession(page);
  const stoppedAt = Date.now();
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await page.waitForFunction(() => {
    const o = window.webrunTest.pendingOutcome();
    return o.call && o.events && o.download;
  });
  const outcome = await page.evaluate(() => window.webrunTest.pendingOutcome());
  log(`service worker stopped (settled in ${Date.now() - stoppedAt} ms)`, outcome);
  for (const name of ["call", "events", "download"]) {
    assert.notEqual(outcome[name], "resolved", `${name} must fail`);
  }
  assert.match(outcome.pipeReason, /cs<->sw: the chrome.runtime.Port disconnected/);
  const after = await page.evaluate(() => window.webrunTest.afterStop());
  log("after the stop", after);
  assert.notEqual(after.deadCall, "resolved");
  assert.equal(after.reconnectSum, 42);
  console.log("PASS");
} catch (error) {
  failed = true;
  console.error("FAIL", error);
} finally {
  await context.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
