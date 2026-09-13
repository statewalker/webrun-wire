#!/usr/bin/env node
/**
 * Downloads the upstream Biscuit conformance corpus. The samples belong to the
 * biscuit project (Apache-2.0) and are fetched rather than vendored, pinned to
 * a commit so the suite is reproducible.
 *
 *   node scripts/fetch-samples.mjs           # fetch unless already complete
 *   node scripts/fetch-samples.mjs --force   # re-fetch regardless
 */
import fs from "node:fs";
import path from "node:path";

// The canonical corpus lives in the specification repository, not in any one
// implementation. Pinned to a commit so the suite is reproducible.
const REF = "b3d3fe2d744ea8ee964ab0eba96dbc8c9bde1639";
const REPO = `https://raw.githubusercontent.com/eclipse-biscuit/biscuit/${REF}`;
const BASE = `${REPO}/samples/current`;
const dir = path.join(import.meta.dirname, "..", "samples");
const force = process.argv.includes("--force");

// raw.githubusercontent resets connections when several dozen requests arrive
// at once, which surfaced as a bare `TypeError: fetch failed` with an
// ECONNRESET cause. Bound the concurrency and retry the resets.
const CONCURRENCY = 6;
const ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, binary = false) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return binary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** Runs `task` over `items`, at most CONCURRENCY in flight. */
async function pooled(items, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  });
  await Promise.all(workers);
}

// A previous run that died partway leaves samples.json on disk beside only some
// of the tokens. Checking for samples.json alone would then treat that corpus as
// complete and skip the fetch forever, so the guard checks every file it names.
function isComplete() {
  const manifest = path.join(dir, "samples.json");
  if (!fs.existsSync(manifest)) return false;
  try {
    const { testcases } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    return testcases.every((tc) => fs.existsSync(path.join(dir, tc.filename)));
  } catch {
    return false;
  }
}

if (!force && isComplete()) process.exit(0);
fs.mkdirSync(dir, { recursive: true });

const json = await get(`${BASE}/samples.json`);
const { testcases } = JSON.parse(json);

await pooled(testcases, async (tc) => {
  fs.writeFileSync(path.join(dir, tc.filename), await get(`${BASE}/${tc.filename}`, true));
});

// samples.json is written only once every token it names is on disk, so the
// completeness check above can never be satisfied by a half-finished corpus.
fs.writeFileSync(path.join(dir, "samples.json"), json);

// The deprecated v1/v2 corpora are used as negative fixtures: a current
// implementation must reject them.
for (const version of ["v1", "v2"]) {
  const sub = path.join(dir, "deprecated", version);
  fs.mkdirSync(sub, { recursive: true });
  const base = `${REPO}/samples/deprecated/${version}`;
  let text;
  try {
    text = await get(`${base}/samples.json`);
  } catch {
    continue;
  }
  const names = [...new Set([...text.matchAll(/"(test\w+\.bc)"/g)].map((m) => m[1]))];
  await pooled(names, async (name) => {
    try {
      fs.writeFileSync(path.join(sub, name), await get(`${base}/${name}`, true));
    } catch {
      // individual deprecated fixtures are allowed to be absent upstream
    }
  });
  fs.writeFileSync(path.join(sub, "samples.json"), text);
  console.log(`fetched ${names.length} deprecated ${version} tokens`);
}

console.log(`fetched ${testcases.length} sample tokens into samples/`);
