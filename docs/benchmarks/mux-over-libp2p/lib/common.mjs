import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";

export const PROTO_A = "/bench-a/1";
export const PROTO_B = "/bench-b/1";
export const te = new TextEncoder();
export const td = new TextDecoder();
export const ACK = new Uint8Array([0x61]);

// cfg.yamuxMaxStreams: undefined = yamux default (1000 in/1000 out per connection)
export async function createNode(cfg = {}) {
  const y = cfg.yamuxMaxStreams
    ? { maxInboundStreams: cfg.yamuxMaxStreams, maxOutboundStreams: cfg.yamuxMaxStreams }
    : {};
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux(y)],
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tick = () => new Promise((r) => setImmediate(r));

export function memSnapshot() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}

// Samples memory every `ms` into a ring of samples; window() summarises.
export function memSampler(ms = 100) {
  const samples = [];
  const t0 = performance.now();
  const take = () => samples.push({ t: performance.now() - t0, ...memSnapshot() });
  take();
  const h = setInterval(take, ms);
  return {
    samples,
    mark: () => samples.length,
    summary(from = 0, to = samples.length) {
      const w = samples.slice(from, to);
      if (w.length === 0) return null;
      const out = {};
      for (const k of ["rss", "heapUsed", "external", "arrayBuffers"]) {
        const start = w[0][k];
        let peak = start;
        for (const s of w) peak = Math.max(peak, s[k]);
        out[k] = { start, peak, end: w[w.length - 1][k], growthPeak: peak - start };
      }
      out.n = w.length;
      return out;
    },
    stop: () => clearInterval(h),
  };
}

export function pct(arr) {
  if (arr.length === 0) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

export function withTimeout(p, ms, label = "timeout") {
  let h;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      h = setTimeout(() => rej(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(h));
}
