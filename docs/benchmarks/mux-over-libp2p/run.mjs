// One measurement run in a fresh process. Usage:
//   node --expose-gc run.mjs '{"scenario":1,"mode":"A","procs":2, ...}'
// Prints one JSON line (prefixed RESULT ) with the measurements.
import { fork } from "node:child_process";
import { getPortCloseSignal } from "@statewalker/webrun-rpc";
import { makeClient } from "./lib/client-core.mjs";
import { memSampler, pct, sleep, tick, withTimeout } from "./lib/common.mjs";
import { adapterStats } from "./lib/stream-port.mjs";

const cfg = {
  aMaxIn: 512,
  aMaxOut: 512, // httpeers' defaults unless overridden
  wire: true,
  ...JSON.parse(process.argv[2] ?? "{}"),
};
const MiB = 1024 * 1024;
const warns = new Map();
const origWarn = console.warn;
console.warn = (...a) => {
  const k = String(a[0]).slice(0, 200);
  warns.set(k, (warns.get(k) ?? 0) + 1);
};
process.on("unhandledRejection", (e) => {
  const k = `unhandledRejection: ${String(e?.message ?? e).slice(0, 200)}`;
  warns.set(k, (warns.get(k) ?? 0) + 1);
});

const sampler = memSampler(100);
const gc = () => {
  globalThis.gc?.();
};

// ---- server handle (same API for in-process and child-process) ----
async function startServerHandle() {
  const srvCfg = { ...cfg, bRaw: cfg.mode === "B1" || cfg.mode === "B3" };
  if (cfg.procs === 1) {
    const { startServer } = await import("./lib/server-core.mjs");
    const srv = await startServer(srvCfg);
    return {
      addr: srv.addr,
      stats: async () => srv.stats(),
      mark: async () => sampler.mark(),
      summary: async (f, t) => sampler.summary(f, t),
      gc: async () => gc(),
      kill: async () => srv.killConnections(),
      stop: () => srv.stop(),
    };
  }
  const child = fork(new URL("./server.mjs", import.meta.url).pathname, [JSON.stringify(srvCfg)], {
    execArgv: ["--expose-gc"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const childStderr = new Map();
  child.stderr.on("data", (d) => {
    const k = String(d).split("\n")[0].slice(0, 200);
    childStderr.set(k, (childStderr.get(k) ?? 0) + 1);
  });
  let seq = 0;
  const pending = new Map();
  const addr = await new Promise((res, rej) => {
    child.on("message", (m) => {
      if (m.ready) return res(m.addr);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error)) : p.res(m.result);
    });
    child.on("exit", (c) => rej(new Error(`server exited ${c}`)));
  });
  const call = (op, ...args) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      child.send({ id, op, args });
    });
  return {
    addr,
    childStderr,
    stats: () => call("stats"),
    mark: () => call("mark"),
    summary: (f, t) => call("summary", f, t),
    gc: () => call("gc"),
    kill: async () => {
      child.kill("SIGKILL");
    },
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    },
  };
}

// ---- helpers ----
const PING = new Uint8Array(64).fill(1);
async function pings(ch, { count = Infinity, until = () => false } = {}) {
  const rtts = [];
  for (let i = 0; i < count && !until(); i++) {
    const t = performance.now();
    ch.send(PING);
    const r = await ch.next();
    if (r.done) throw new Error("echo channel ended");
    rtts.push(performance.now() - t);
  }
  return rtts;
}
async function readBytes(
  ch,
  { target = Infinity, deadline = Infinity, rateBps = 0, t0 = performance.now() } = {},
) {
  let consumed = 0;
  while (consumed < target && performance.now() < deadline) {
    if (rateBps) {
      const allowed = ((performance.now() - t0) / 1000) * rateBps;
      if (consumed >= allowed) {
        await sleep(5);
        continue;
      }
    }
    const r = await ch.next();
    if (r.done) break;
    consumed += r.value.byteLength;
  }
  return consumed;
}
async function memWindow(srv, fn) {
  gc();
  await srv.gc();
  await sleep(150);
  const cm = sampler.mark();
  const sm = await srv.mark();
  const out = await fn();
  await sleep(120);
  return {
    ...out,
    memClient: sampler.summary(cm),
    memServer: cfg.procs === 2 ? await srv.summary(sm) : "same-process",
  };
}
async function warmup(client) {
  const P = client.open({ k: "echo" });
  await P.ready;
  await pings(P, { count: 300 });
  const W = client.open({ k: "bulk", size: MiB, total: 20 * MiB });
  await W.ready;
  await readBytes(W, { target: 20 * MiB });
  await W.cancel();
  return P;
}

// ---- scenarios ----
const scenarios = {
  // 1. latency of P while Q streams bulk server->client as fast as the client reads.
  async 1(client, srv) {
    const P = await warmup(client);
    const baseline = pct(await pings(P, { count: 2000 }));
    const res = await memWindow(srv, async () => {
      const Q = client.open({ k: "bulk", size: MiB, total: 1e15 });
      await Q.ready;
      const t0 = performance.now();
      const deadline = t0 + (cfg.durationMs ?? 10_000);
      let done = false;
      const reader = readBytes(Q, { deadline }).finally(() => {
        done = true;
      });
      const rtt = await pings(P, { until: () => done || performance.now() > deadline });
      const consumed = await reader;
      const secs = (performance.now() - t0) / 1000;
      void Q.cancel();
      return { loaded: pct(rtt), bulkMBps: consumed / MiB / secs, bulkMiB: consumed / MiB };
    });
    return { baseline, ...res };
  },

  // 2. Q's client reads slowly (2 MB/s) or not at all for 5 s.
  async 2(client, srv) {
    const P = await warmup(client);
    const baseline = pct(await pings(P, { count: 500 }));
    const res = await memWindow(srv, async () => {
      const s0 = (await srv.stats()).bulkProduced;
      const a0 = adapterStats.maxQueuedBytes;
      adapterStats.maxQueuedBytes = adapterStats.queuedBytes;
      const Q = client.open({ k: "bulk", size: MiB, total: 1e15 });
      await Q.ready;
      const t0 = performance.now();
      const win = cfg.windowMs ?? 5000;
      const deadline = t0 + win;
      const timeline = [];
      const poll = setInterval(async () => {
        const s = await srv.stats();
        timeline.push({
          t: Math.round(performance.now() - t0),
          producedMiB: (s.bulkProduced - s0) / MiB,
          srvQueueMiB: s.adapter.queuedBytes / MiB,
        });
      }, 500);
      const reader =
        cfg.variant === "stall"
          ? sleep(win).then(() => 0)
          : readBytes(Q, { deadline, rateBps: 2e6, t0 });
      const rtt = await pings(P, { until: () => performance.now() > deadline });
      const consumed = await reader;
      clearInterval(poll);
      const s1 = await srv.stats();
      const out = {
        during: pct(rtt),
        consumedMiB: consumed / MiB,
        producedMiB: (s1.bulkProduced - s0) / MiB,
        timeline,
        clientAdapterMaxQueuedMiB: client.port ? adapterStats.maxQueuedBytes / MiB : null,
        serverAdapterMaxQueuedMiB: s1.adapter.maxQueuedBytes / MiB,
        serverAdapterQueuedNowMiB: s1.adapter.queuedBytes / MiB,
        rawInboxMaxMiB: Q.stats.maxInboxBytes / MiB,
      };
      void a0;
      void Q.cancel().catch(() => {});
      return out;
    });
    return { baseline, ...res };
  },

  // 3. K channels flooding 256-byte messages client->server for 5 s.
  async 3(client, srv) {
    await warmup(client);
    const K = cfg.k;
    const msg = new Uint8Array(256).fill(3);
    let stop = false;
    const res = await memWindow(srv, async () => {
      const chans = [];
      for (let i = 0; i < K; i++) {
        if (client.raw) {
          const ch = client.open({ k: "flood" });
          chans.push(ch);
          void ch.ready.then(async () => {
            while (!stop) {
              for (let j = 0; j < 32 && !stop; j++) ch.send(msg);
              if (ch.room) await ch.room();
              await tick();
            }
          });
        } else {
          chans.push(
            client.open(
              { k: "flood" },
              (async function* () {
                while (!stop) yield msg;
              })(),
            ),
          );
        }
      }
      await Promise.all(chans.map((c) => c.ready));
      // Keep pulling each channel's output: under duplexOverPort's lockstep
      // (spec D11) the server handler cannot get past its ACK until the client
      // pulls past it, so a client that stops pulling stalls its own input.
      if (!client.raw)
        for (const c of chans)
          void (async () => {
            try {
              for (;;) {
                const r = await c.next();
                if (r.done) return;
              }
            } catch {}
          })();
      await sleep(1000);
      const a = await srv.stats();
      const t0 = performance.now();
      await sleep(cfg.durationMs ?? 5000);
      const b = await srv.stats();
      const secs = (performance.now() - t0) / 1000;
      stop = true;
      const out = {
        msgsPerSec: (b.floodMsgs - a.floodMsgs) / secs,
        MBps: (b.floodBytes - a.floodBytes) / 1e6 / secs,
        clientAdapterMaxQueuedMiB: client.port ? adapterStats.maxQueuedBytes / MiB : null,
        clientAdapterQueuedAtEndMiB: client.port ? adapterStats.queuedBytes / MiB : null,
      };
      return out;
    });
    return res;
  },

  // 4. N idle channels + one ping-pong channel.
  async 4(client, srv) {
    const P = await warmup(client);
    const N = cfg.n;
    const res = await memWindow(srv, async () => {
      const t0 = performance.now();
      const chans = Array.from({ length: N }, () => client.open({ k: "idle" }));
      const settled = await Promise.allSettled(
        chans.map((c) => withTimeout(c.ready, 30_000, "ready timeout 30s")),
      );
      const setupMs = performance.now() - t0;
      const ok = settled.filter((s) => s.status === "fulfilled").length;
      const errs = {};
      for (const s of settled)
        if (s.status === "rejected") {
          const k = String(s.reason?.message ?? s.reason).slice(0, 200);
          errs[k] = (errs[k] ?? 0) + 1;
        }
      await sleep(300);
      let rtt;
      try {
        rtt = pct(await withTimeout(pings(P, { count: 500 }), 30_000, "ping timeout"));
      } catch (e) {
        rtt = { error: String(e.message) };
      }
      const s = await srv.stats();
      return {
        setupMs,
        ok,
        failed: N - ok,
        errors: errs,
        rtt,
        serverOpenChannels: s.openChannels,
        serverErrors: s.errors,
      };
    });
    return res;
  },

  // 5. 100 open channels, then kill the connection; time until each channel notices.
  async 5(client, srv) {
    await warmup(client);
    const N = 100;
    const chans = Array.from({ length: N }, () => client.open({ k: "idle" }));
    await Promise.all(chans.map((c) => c.ready));
    // endInput: the client has finished sending (e.g. an HTTP request body is
    // complete) and only waits for the response.
    if (cfg.endInput) for (const c of chans) c.end();
    const settleAt = new Array(N).fill(null);
    const how = {};
    let tKill = 0;
    chans.forEach((c, i) => {
      c.next().then(
        (r) => {
          settleAt[i] = performance.now();
          const k = r.done ? "done" : "value";
          how[k] = (how[k] ?? 0) + 1;
        },
        (e) => {
          settleAt[i] = performance.now();
          const k = `error: ${String(e?.message ?? e).slice(0, 160)}`;
          how[k] = (how[k] ?? 0) + 1;
        },
      );
    });
    const portAborts = new Array(N).fill(null);
    if (client.raw)
      chans.forEach((c, i) => {
        getPortCloseSignal(c.port)?.addEventListener("abort", () => {
          portAborts[i] = performance.now();
        });
      });
    await sleep(200);
    const srvBefore = cfg.procs === 1 ? await srv.stats() : null;
    tKill = performance.now();
    await srv.kill();
    const limit = tKill + 30_000;
    while (performance.now() < limit && settleAt.some((x) => x === null)) await sleep(20);
    const times = settleAt.filter((x) => x !== null).map((x) => x - tKill);
    const conns = client.node.getConnections();
    const out = {
      settled: times.length,
      unsettledAfter30s: N - times.length,
      settleMs: pct(times),
      how,
      clientConnectionsAfter: conns.length,
      clientStreamsAfter: conns.reduce((a, c) => a + c.streams.length, 0),
      clientAdapterPorts: client.port ? adapterStats.ports : null,
    };
    if (client.raw) {
      const pa = portAborts.filter((x) => x !== null).map((x) => x - tKill);
      out.rawPortCloseSignals = { aborted: pa.length, notAborted: N - pa.length, ms: pct(pa) };
    }
    if (cfg.procs === 1) {
      const s = await srv.stats();
      out.serverOpenChannelsBefore = srvBefore.openChannels;
      out.serverOpenChannelsAfter = s.openChannels;
    }
    return out;
  },
};

const t = performance.now();
let result;
let srv;
try {
  srv = await startServerHandle();
  const client = await makeClient(srv.addr, cfg.mode, cfg);
  result = await scenarios[cfg.scenario](client, srv);
} catch (e) {
  result = { fatal: String(e?.stack ?? e).slice(0, 600) };
}
result.wallMs = performance.now() - t;
result.warnings = Object.fromEntries(warns);
if (srv?.childStderr) result.serverStderr = Object.fromEntries(srv.childStderr);
process.stdout.write(`RESULT ${JSON.stringify({ cfg, result })}\n`);
srv?.stop?.();
sampler.stop();
setTimeout(() => process.exit(0), 50);
void origWarn;
