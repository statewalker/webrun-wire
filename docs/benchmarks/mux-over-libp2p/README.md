# Many channels over libp2p: streams vs virtual ports

Compares four ways to carry many bidirectional channels (sockets, HTTP exchanges) between two
libp2p peers:

| Mode | How |
|---|---|
| **A** | One libp2p (yamux) stream per channel: webrun-streams-libp2p `connect` / `serveConnections`, limits 512/512 as in httpeers. |
| **B1** | `multiplexPort` virtual ports over **one** libp2p stream; the app calls `postMessage` directly. No flow control. |
| **B2** | As B1, with webrun-rpc `connect` / `serve` and `duplexOverPort` on each port. Its stream layer allows one acknowledged chunk per port. |
| **B3** | As B1, with the experimental per-port `window` (256 KiB unless set). The reader's listener returns a promise that settles when the app takes the message. Senders wait for `whenPortReady`. |

The mux runs over `lib/stream-port.mjs`, a minimal `MessageTarget` over one libp2p stream:
- each frame is a 4-byte length prefix plus a msgpack envelope (`msgpackCodec`);
- sends go through one queue that waits for the stream's `drain`;
- incoming frames are dispatched as they arrive.

## Run

```sh
npm install                 # libp2p, yamux, noise, tcp, webrun-* from npm
# B3 needs the prototype: build webrun-rpc and webrun-msgpack from this branch and copy their
# dist/ over node_modules/@statewalker/webrun-rpc/dist and .../webrun-msgpack/dist.
node bench.mjs all 3        # every scenario, 3 repetitions each, 1 and 2 processes (~1 h)
MODES=A,B3 PROCS=2 node bench.mjs 1 3     # some modes / scenarios
node --expose-gc run.mjs '{"scenario":1,"mode":"B3","procs":2,"window":4194304}'   # one run
node summarize.mjs > results/summary.md
```

Each run is a fresh process; the median of 3 runs is reported, with min–max in brackets in
`results/summary.md`. The raw records are in `results/s1.json` … `results/s5.json`, and the
machine in `results/machine.json`.

## Scenarios

1. **Latency under load.** 64 B ping-pong on channel P while channel Q streams 1 MiB chunks for 10 s.
2. **Slow consumer.** Q's reader takes 2 MB/s, or nothing for 5 s, while P pings.
3. **Throughput.** K channels (1, 10, 100) send 256 B messages for 5 s.
4. **Many channels.** 1,000 and 2,000 idle channels plus one ping channel.
5. **Connection drop.** 100 open channels, then the peer is SIGKILLed or the connection aborted.

## Results

Recorded on 2026-11-06 on one machine:
- **Hardware:** 4× Intel Xeon @ 2.10 GHz, 16 GB RAM.
- **Software:** Node 22.22; libp2p 3.5.1, yamux 8.0.1, noise 17, TCP on 127.0.0.1.
- **Layout:** two processes (client and server).

Medians of 3 runs:

| | A | B1 | B2 | B3 (256 KiB) |
|---|---|---|---|---|
| Ping p50, idle (ms) | 0.29 | 0.22 | 0.69 | 0.21 |
| Ping p50 / p99 while Q streams 1 MiB chunks (ms) | 57 / 131 | 162 / 1,229 | 6.8 / 23.5 | **2.9 / 12.1** |
| Q's bulk throughput meanwhile (MB/s) | 253 | 341 | 174 | 194 |
| Ping p50 / p99 while Q's reader is stalled (ms) | 32 / 136 | 25 / 3,890 | 0.57 / 2.2 | **0.15 / 0.9** |
| Memory growth while Q's reader is stalled 5 s | +1.0 GB (client) | +1.6 GB client, +0.9 GB server | +4 MB | **≈ 0** |
| Server produced for the stalled reader (MiB) | 963 | 2,390 | 0 | 2 |
| 256 B messages/s, K = 10 | 52,410 | 38,246 | 9,435 | 36,537 |
| 256 B messages/s, K = 100 | 46,743 | 38,218 | 11,970 | 38,246 |
| 2,000 channels: opened / setup / server memory | 2,000 / 1,128 ms / +82 MB (limits raised to 4,096) | 1,023 (maxPorts) | 2,000 / 438 ms / +32 MB (maxPorts 4,096) | **2,000 / 388 ms / +17 MB** (maxPorts 4,096) |
| Connection drop: channels settled within 30 s (input open) | 0 of 100 (hang) | 100 (close wired) / 0 (not wired) | 100 / 0 | 100 in 15 ms (close wired) |

How the window trades latency against bulk throughput (scenario 1, B3, 2 processes, 3 runs each):

| Window | Ping p50 / p99 (ms) | Q bulk (MB/s) |
|---|---|---|
| 256 KiB | 2.7–3.0 / 11–13 | 175–194 |
| 4 MiB | 8.3–9.5 / 22–25 | 275–305 |

## What the numbers say

- **Per-port credit removes head-of-line blocking and unbounded buffering.** A slow or stalled channel costs the others nothing, and memory stays flat. Under load, latency is 20× better than one stream per channel (p50 2.9 against 57 ms).
- **The window is a knob.** 256 KiB favours latency. 4 MiB brings bulk throughput above A's (275–305 against 253 MB/s) with pings still about 5× better.
- **Small messages: B3 matches raw ports, at 65–82% of A (K = 1–100).** The gap is the same without credit (B1), so it comes from one shared stream plus per-message framing, not from the window.
- **A (httpeers today) has no end-to-end backpressure either.** libp2p's stream iterator buffers without limit, and a dead peer hangs or silently ends its calls (statewalker/webrun-wire#40).

## Caveats

- Loopback only: no real latency or bandwidth limits, so round trips are CPU-bound.
- httpeers itself was not run; mode A uses the same package and limits.
- In B1 and B3 the app's message loop yields a tick every 32 messages, as an app on a raw port would. Without the yield, a sender with credit to spare never yields to the event loop and starves its own socket.
