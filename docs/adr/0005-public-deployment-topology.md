# 5. Public deployment topology for `p2p-demo`

Date: 2026-05-17

## Status

Accepted.

## Context

[`apps/p2p-demo`](../../apps/p2p-demo/) runs locally over `ws://localhost:9090`. To exercise the demo against arbitrary browsers on the public internet (and inside corporate networks), four distinct concerns need a host:

1. **The libp2p relay.** [`relay/server.ts`](../../apps/p2p-demo/relay/server.ts) is a long-running Node process that holds (a) a Circuit Relay v2 listener for browsers behind NAT and (b) a gossipsub forwarder that auto-subscribes to every `webrun/*` topic it sees a connected peer advertise. Both are stateful: Circuit Relay reservations are tied to the relay's PeerID and persist for the entire tab session; gossipsub mesh membership is per-process. The relay cannot be reduced to request-scoped invocation.

2. **TURN/STUN.** WebRTC's ICE layer needs a public reflector to traverse symmetric NATs and corporate firewalls. The current code passes no `rtcConfiguration`, so restrictive-NAT users stay pinned to the Circuit Relay path indefinitely. Adding `iceServers` brings them onto direct WebRTC data channels via a TURN relay.

3. **Static assets.** The Vite-built `client-page/` and `server-page/` (and any future demo app) must be served from a stable HTTPS origin. Build-time env vars (`VITE_RELAY_MULTIADDR`, `VITE_GROUP_ID`) currently bake the relay address into the bundle, which blocks the same image from being re-used by a different deployment (corp on-prem, staging, …).

4. **TLS and routing.** All three concerns share port 443; routing has to be SNI-based and at least one (TURN-over-TLS) requires passthrough rather than re-termination.

Several superficially attractive deployment shapes do not survive the constraints:

- **AWS Lambda / Vercel Functions / Cloudflare Workers (without Durable Objects) / Deno Deploy.** Request-scoped, multi-isolate runtimes. The libp2p relay needs a single persistent process with a stable PeerID; multi-isolate routing silently fragments the gossipsub mesh (two browsers landing on two isolates never see each other's announcements), and isolate eviction nukes Circuit Relay reservations. The same architectural shape rules out all four.
- **Community-run public libp2p bootstrap nodes.** They host Circuit Relay v2 but do not auto-subscribe to our `webrun/<groupId>/*` topics, so the discovery layer silently breaks.
- **Cloudflare-Tunnel-fronted relay.** Tunnels are HTTP-aware; they will not preserve the SNI-passthrough we need for coturn's TURN-over-TLS listener on `:443`.
- **WebTransport-based relay.** `@libp2p/webtransport` is a browser dialer; the Node server-side is not GA. Even if it were, WebTransport is client→server only — it cannot replace WebRTC for browser↔browser links.
- **Cloudflare Realtime SFU.** SFUs forward media tracks at scale; the demo carries HTTP requests over a single point-to-point WebRTC data channel. Wrong abstraction.

The deployment also has to remain runnable on-premise inside high-security corporate networks (banks, insurance, gov-adjacent — `~0.5%` of users blocked by SaaS allowlists or DPI on the public path). On-prem is the only complete answer for those tenants; the architecture must not lock us out of it.

## Decision

The demo is deployed as a single `docker compose` stack on one VPS (`Hetzner CX22`, €4.51/mo, 2 vCPU / 4 GB / 20 TB egress — portable to OVH / IONOS / DigitalOcean without code changes). The stack contains five containers:

| Container       | Public on 443         | Role                                                                      |
|-----------------|-----------------------|---------------------------------------------------------------------------|
| `traefik`       | yes (SNI router)      | TLS termination + LetsEncrypt for `app/relay/rustfs.*`; SNI passthrough for `turn.*` |
| `relay`         | via Traefik (WSS)     | unchanged `relay/server.ts` — Circuit Relay v2 + gossipsub forwarder      |
| `coturn`        | direct (SNI from Traefik) on `:443` + UDP `:3478` + TCP `:5349` | TURN/STUN |
| `rustfs`        | via Traefik (`rustfs.*`)| S3-compatible object storage, multi-deployment bucket                   |
| `static-server` | via Traefik (`app.*`) | Maps URL prefixes to bucket prefixes per `_config.json`                   |

DNS:

- `app.example.com` &rarr; VPS IPv4 — the static pages
- `relay.example.com` &rarr; VPS IPv4 — the libp2p relay's WSS endpoint
- `turn.example.com` &rarr; VPS IPv4 — coturn
- `rustfs.example.com` &rarr; VPS IPv4 — the S3 API, rate-limited at Traefik

Cloudflare is recommended as the DNS provider for free DDoS protection at the DNS layer; proxy-mode is **off** (would break SNI passthrough to coturn and add latency on the WS path for zero benefit at this scale).

### Static assets: multi-tenant S3-backed

A single bucket (`sites`) hosts all deployed apps. The bucket layout is one folder per immutable deployment + a root `_config.json`:

```
sites/
├── _config.json
├── client-a1b2c3d/
│   ├── index.html
│   └── ...
├── server-a1b2c3d/
└── ...
```

`_config.json` is the source of truth for routing:

```json
{
  "default": "main",
  "deployments": {
    "main":   { "prefix": "main-v1.0.0",     "spa": true,  "cacheHtml": "no-cache" },
    "client": { "prefix": "client-a1b2c3d",  "spa": true },
    "server": { "prefix": "server-a1b2c3d",  "spa": true }
  }
}
```

`static-server` resolves each request by checking whether the first path segment matches a deployment name; if so it strips and rewrites to `<prefix>/<rest>`, otherwise it falls back to the default deployment. Missing objects in SPA deployments serve the deployment's `index.html`. The config is re-read every 5s via `If-None-Match` against `_config.json`'s ETag; updates propagate without a restart.

**Deploys are versioned + atomic.** CI uploads to a new prefix (`client-<git-sha>/`) and writes a new `_config.json` with the updated `prefix` field. The flip is a single S3 PUT visible to the proxy within 5s. Rollback is `aws s3 cp` of the previous `_config.json`.

### TURN: self-hosted coturn

coturn runs on the same VPS, listening on UDP `:3478`, TCP `:5349`, and TCP `:443`. Traefik does SNI passthrough for `turn.example.com:443` so coturn terminates TLS with its own certificate, read from a shared volume that Traefik's LetsEncrypt resolver writes to (DNS-01 challenge via the DNS provider's API). This is the standard "Traefik in front of a TURN server" pattern.

Self-hosted is chosen over managed (Cloudflare Realtime TURN, Twilio, Metered.ca) because at demo scale the per-GB savings are immaterial, and the Docker stack stays portable to environments without internet egress (on-prem). The trade-off — Traefik / cert / port-443-sharing setup is more involved — is paid once.

### On-prem variant

The same `docker-compose.yml` is parameterised so corp IT can run it inside their perimeter with:

- Internal DNS pointing `app/relay/turn/rustfs.corp.internal` at one internal VM
- Corp-CA-issued certificates mounted as static files (Traefik's LetsEncrypt resolver disabled)
- A runtime `/config.json` fetched by each page on boot, replacing the Vite-built-in env vars

This makes the architecture viable for the Tier-4 users that the public deployment cannot reach.

## Rationale

- **One persistent process for the relay.** Mesh state and Circuit Relay reservations both require it. Every serverless alternative breaks discovery silently. The pricing math also favours a long-running container at this traffic level — one WebSocket per tab for hours of session time would cost more on per-request-billed serverless than on a €4/mo VPS.
- **Traefik with SNI passthrough for coturn.** The only TLS layout that lets all four hostnames share port 443. Avoids the per-protocol special-case Cloudflare-Tunnel-style approaches force.
- **S3-backed multi-tenant static hosting.** Eliminates per-app Docker images; each new demo app is `aws s3 sync` + one config line. Aligns with how Vercel / Netlify / Cloudflare Pages work internally (immutable versioned deploys, atomic config flip). The proxy is ~80 lines of code; the operational simplification is large.
- **Versioned prefixes + config flip.** Atomic deploys without RustFS-specific object versioning. Rollback is one S3 PUT. Garbage collection of old prefixes is a separate cron.
- **Portable Docker stack.** Hetzner is the default; nothing in the design depends on Hetzner-specific features. Moving to OVH (cheaper UDP DDoS protection), IONOS, DigitalOcean, or an on-prem VM is one `terraform apply` + DNS swap.

## Consequences

**Positive**

- Public-internet demo reachable for ≈99% of users (≈95% direct WebRTC, ≈4% via TURN-over-TLS, ≈0.5% via Circuit Relay fallback on DPI corp networks). The remaining ≈0.5% are addressable via the on-prem variant.
- Adding a new demo app: one `aws s3 sync` + one line in `_config.json`. No image rebuild, no SSH, no host access.
- Atomic, instant rollback: revert `_config.json` to the previous version.
- Stack is portable across providers; no lock-in.
- coturn's UDP traffic is the only protocol-sensitive component. If the host blocks UDP poorly (some Fly regions), TURN-over-TCP/TLS on `:443` still works.

**Negative / costs**

- One small new code artefact: `static-server` (~80 LOC TypeScript + Dockerfile). Maintained inside the demo repo; promote to a workspace package only if a second consumer appears.
- Two TLS termination points (Traefik for HTTP services; coturn for TURN-over-TLS) require coordinated cert lifecycle — Traefik's LE resolver writes cert files to a shared volume; coturn watches and reloads. Adds one volume mount and a small reload hook.
- Page bundles currently bake `VITE_RELAY_MULTIADDR` etc. at build time. The on-prem variant requires migrating to a runtime `/config.json` fetch (small refactor; not blocking for the public deployment but blocking before the first on-prem install).
- Old deployment prefixes accumulate in the bucket and need a retention cron (`scripts/gc.sh`, weekly, keep last 5).
- The `rustfs.example.com` S3 endpoint is publicly reachable; abuse-monitoring at Traefik's rate-limit middleware is the only safety net. Per-app S3 credentials with prefix-scoped policies contain blast radius; rotation is manual.

**Out of scope, deferred**

- SFU / media routing (no media traffic in scope).
- WebTransport-based browser↔relay link (`@libp2p/webtransport` Node-server not GA in 2026; revisit when `webrun-p2p-mesh` is extracted).
- Multi-region relays (single-relay PeerID requires browser to dial the relay it reserved on; multi-region needs a coordination layer not warranted at current scale).
- Auth on private deployments (basic-auth middleware on `static-server` per deployment; trivial to add when first needed).
- Object-versioning in RustFS for cross-deploy asset deduplication (not yet supported, and the versioned-prefix model already gives atomic deploys).
