// node summarize.mjs  -> markdown tables (median of reps, [min-max]) to stdout and results/summary.md
import fs from "node:fs";

const dir = new URL("./results/", import.meta.url).pathname;
const load = (s) => {
  try {
    return JSON.parse(fs.readFileSync(`${dir}s${s}.json`, "utf8"));
  } catch {
    return [];
  }
};
const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const med = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const f = (x, d = 1) =>
  Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d)) : "–";
function cell(recs, path, d = 1, scale = 1) {
  const xs = recs
    .map((r) => get(r.result, path))
    .filter((x) => typeof x === "number")
    .map((x) => x / scale);
  if (!xs.length) return "–";
  const m = med(xs),
    lo = Math.min(...xs),
    hi = Math.max(...xs);
  return lo === hi || xs.length === 1 ? f(m, d) : `${f(m, d)} [${f(lo, d)}–${f(hi, d)}]`;
}
function group(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r.cfg);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
const MB = 1e6;
let out = "";
const p = (s = "") => {
  out += `${s}\n`;
};
const fatals = (recs) => recs.filter((r) => r.result.fatal).length;

// S1
{
  const g = group(load(1), (c) => `${c.mode} | ${c.procs}p`);
  p(
    "### S1 latency under load (P ping-pong 64 B; Q bulk 1 MiB chunks for 10 s, read as fast as possible)",
  );
  p(
    "| mode | procs | baseline p50 / p99 ms | loaded p50 ms | loaded p95 ms | loaded p99 ms | loaded max ms | pings | Q MB/s | client RSS grow MB | server RSS grow MB | fatal |",
  );
  p("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, rs] of g)
    p(
      `| ${k} | ${cell(rs, "baseline.p50", 2)} / ${cell(rs, "baseline.p99", 2)} | ${cell(rs, "loaded.p50")} | ${cell(rs, "loaded.p95")} | ${cell(rs, "loaded.p99")} | ${cell(rs, "loaded.max")} | ${cell(rs, "loaded.n", 0)} | ${cell(rs, "bulkMBps", 0, 1 / 1.048576)} | ${cell(rs, "memClient.rss.growthPeak", 0, MB)} | ${cell(rs, "memServer.rss.growthPeak", 0, MB)} | ${fatals(rs)} |`,
    );
  p();
}
// S2
{
  const g = group(load(2), (c) => `${c.variant} | ${c.mode} | ${c.procs}p`);
  p("### S2 slow consumer on Q (slow = 2 MB/s, stall = no reads) for 5 s; P pings meanwhile");
  p(
    "| variant | mode | procs | P p50 ms | P p99 ms | P max ms | Q consumed MiB | Q produced by server MiB | client arrayBuffers grow MB | server arrayBuffers grow MB | server adapter queue max MiB | B1 app inbox max MiB | fatal |",
  );
  p("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, rs] of g)
    p(
      `| ${k} | ${cell(rs, "during.p50", 2)} | ${cell(rs, "during.p99")} | ${cell(rs, "during.max")} | ${cell(rs, "consumedMiB", 0)} | ${cell(rs, "producedMiB", 0)} | ${cell(rs, "memClient.arrayBuffers.growthPeak", 0, MB)} | ${cell(rs, "memServer.arrayBuffers.growthPeak", 0, MB)} | ${cell(rs, "serverAdapterMaxQueuedMiB", 0)} | ${cell(rs, "rawInboxMaxMiB", 0)} | ${fatals(rs)} |`,
    );
  p();
}
// S3
{
  const g = group(load(3), (c) => `${c.k} | ${c.mode} | ${c.procs}p`);
  p("### S3 throughput: K channels, 256 B messages client→server, 5 s");
  p(
    "| K | mode | procs | msgs/s | MB/s | client adapter queue max MiB | client RSS grow MB | fatal |",
  );
  p("|---|---|---|---|---|---|---|---|");
  for (const [k, rs] of g)
    p(
      `| ${k} | ${cell(rs, "msgsPerSec", 0)} | ${cell(rs, "MBps", 2)} | ${cell(rs, "clientAdapterMaxQueuedMiB", 1)} | ${cell(rs, "memClient.rss.growthPeak", 0, MB)} | ${fatals(rs)} |`,
    );
  p();
}
// S4
{
  const g = group(load(4), (c) => `${c.n} | ${c.label} | ${c.procs}p`);
  p("### S4 many idle channels + one ping-pong channel");
  p(
    "| N | config | procs | opened OK | failed | setup ms | RTT p50 / p99 ms | server RSS grow MB | client RSS grow MB | errors (rep 0) |",
  );
  p("|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, rs] of g) {
    const errs =
      Object.entries(rs[0]?.result.errors ?? {})
        .map(([e, n]) => `${n}× ${e}`)
        .join("; ") || (rs[0]?.result.fatal ? `FATAL ${rs[0].result.fatal.slice(0, 120)}` : "");
    p(
      `| ${k} | ${cell(rs, "ok", 0)} | ${cell(rs, "failed", 0)} | ${cell(rs, "setupMs", 0)} | ${cell(rs, "rtt.p50", 2)} / ${cell(rs, "rtt.p99", 1)} | ${cell(rs, "memServer.rss.growthPeak", 0, MB)} | ${cell(rs, "memClient.rss.growthPeak", 0, MB)} | ${errs} |`,
    );
  }
  p();
}
// S5
{
  const g = group(
    load(5),
    (c) => `${c.label} | ${c.procs === 2 ? "2p SIGKILL server" : "1p server aborts conn"}`,
  );
  p("### S5 connection drop with 100 open channels (wait up to 30 s)");
  p(
    "| config | kill | settled | still pending at 30 s | settle p50 ms | settle max ms | how channels ended (rep 0) | server open channels after (1p) |",
  );
  p("|---|---|---|---|---|---|---|---|");
  for (const [k, rs] of g) {
    const how =
      Object.entries(rs[0]?.result.how ?? {})
        .map(([e, n]) => `${n}× ${e}`)
        .join("; ") || "nothing";
    p(
      `| ${k} | ${cell(rs, "settled", 0)} | ${cell(rs, "unsettledAfter30s", 0)} | ${cell(rs, "settleMs.p50")} | ${cell(rs, "settleMs.max")} | ${how} | ${cell(rs, "serverOpenChannelsAfter", 0)} |`,
    );
  }
  p();
}
fs.writeFileSync(`${dir}summary.md`, out);
process.stdout.write(out);
