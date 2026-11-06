// Driver: node bench.mjs <scenario 1-5|all|machine> [reps=3]
// Each run is a fresh `node --expose-gc run.mjs <cfg>` process; raw records are
// appended to results/s<N>.json.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const dir = new URL("./results/", import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });
const [, , which = "all", repsArg = "3"] = process.argv;
const REPS = Number(repsArg);

const modes = (process.env.MODES ?? "A,B2,B1,B3").split(",");
const procsList = (process.env.PROCS ?? "1,2").split(",").map(Number);
const plans = {
  1: () =>
    modes.flatMap((mode) =>
      procsList.map((procs) => ({ scenario: 1, mode, procs, durationMs: 10_000 })),
    ),
  2: () =>
    ["slow", "stall"].flatMap((variant) =>
      modes.flatMap((mode) => procsList.map((procs) => ({ scenario: 2, mode, procs, variant }))),
    ),
  3: () =>
    [1, 10, 100].flatMap((k) =>
      modes.flatMap((mode) =>
        procsList.map((procs) => ({ scenario: 3, mode, procs, k, durationMs: 5000 })),
      ),
    ),
  4: () => {
    const configs0 = [
      { label: "A libp2p-default (32 in/64 out)", mode: "A", aMaxIn: null, aMaxOut: null },
      { label: "A 512 (httpeers)", mode: "A" },
      { label: "A 4096, yamux default", mode: "A", aMaxIn: 4096, aMaxOut: 4096 },
      {
        label: "A 4096, yamux 4096",
        mode: "A",
        aMaxIn: 4096,
        aMaxOut: 4096,
        yamuxMaxStreams: 4096,
      },
      { label: "B2 maxPorts default 1024", mode: "B2" },
      { label: "B2 maxPorts 4096", mode: "B2", maxPorts: 4096 },
      { label: "B1 maxPorts default 1024", mode: "B1" },
      { label: "B3 maxPorts default 1024", mode: "B3" },
      { label: "B3 maxPorts 4096", mode: "B3", maxPorts: 4096 },
    ];
    const configs = configs0.filter((c) => modes.includes(c.mode));
    return [1000, 2000].flatMap((n) =>
      configs.flatMap((c) => procsList.map((procs) => ({ scenario: 4, n, procs, ...c }))),
    );
  },
  5: () => {
    const configs0 = [
      { label: "A, input open", mode: "A" },
      { label: "A, input ended", mode: "A", endInput: true },
      { label: "B2 wired", mode: "B2" },
      { label: "B2 wired, input ended", mode: "B2", endInput: true },
      { label: "B2 naive (no close wiring)", mode: "B2", wire: false },
      { label: "B1 wired", mode: "B1" },
      { label: "B1 naive (no close wiring)", mode: "B1", wire: false },
      { label: "B3 wired", mode: "B3" },
    ];
    const configs = configs0.filter((c) => modes.includes(c.mode));
    return configs.flatMap((c) => procsList.map((procs) => ({ scenario: 5, procs, ...c })));
  },
};

function machine() {
  const pkgs = [
    "@statewalker/webrun-rpc",
    "@statewalker/webrun-msgpack",
    "@statewalker/webrun-streams-libp2p",
    "@statewalker/webrun-streams",
    "libp2p",
    "@chainsafe/libp2p-yamux",
    "@chainsafe/libp2p-noise",
    "@libp2p/tcp",
    "@libp2p/utils",
    "@libp2p/interface",
  ];
  const versions = Object.fromEntries(
    pkgs.map((p) => [
      p,
      JSON.parse(fs.readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url)))
        .version,
    ]),
  );
  const info = {
    date: new Date().toISOString(),
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    versions,
    yamuxDefaults:
      "initialStreamWindowSize 256 KiB, maxStreamWindowSize 16 MiB, maxMessageSize 64 KiB, maxInboundStreams 1000, maxOutboundStreams 1000 per connection, maxReadBufferLength 4 MiB, maxWriteBufferLength Infinity",
    libp2pDefaults:
      "registrar maxInboundStreams 32, maxOutboundStreams 64 per protocol per connection",
  };
  fs.writeFileSync(`${dir}machine.json`, JSON.stringify(info, null, 2));
  console.log(info);
}

function runPlan(s) {
  const file = `${dir}s${s}.json`;
  const records = [];
  for (const cfg of plans[s]()) {
    for (let rep = 0; rep < REPS; rep++) {
      const r = spawnSync(process.execPath, ["--expose-gc", "run.mjs", JSON.stringify(cfg)], {
        cwd: new URL(".", import.meta.url).pathname,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 64 << 20,
      });
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
      const rec = line
        ? JSON.parse(line.slice(7))
        : {
            cfg,
            result: {
              fatal: `no result (status ${r.status}, signal ${r.signal}) ${String(r.stderr).slice(-400)}`,
            },
          };
      rec.rep = rep;
      records.push(rec);
      fs.writeFileSync(file, JSON.stringify(records, null, 1));
      console.log(
        `s${s} ${JSON.stringify(cfg)} rep${rep} ${rec.result.fatal ? `FATAL ${rec.result.fatal.slice(0, 200)}` : `ok ${Math.round(rec.result.wallMs)}ms`}`,
      );
    }
  }
}

if (which === "machine") machine();
else if (which === "all") {
  machine();
  for (const s of [1, 2, 3, 4, 5]) runPlan(s);
} else runPlan(Number(which));
void execFileSync;
