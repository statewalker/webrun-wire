#!/usr/bin/env bash
# Launch all four pieces of livekit-demo:
#   1. LiveKit server (Docker, dev mode, port 7880)
#   2. token-service (Node, port 9091) — issues signed JWTs
#   3. server-page Vite dev server on 5275
#   4. client-page Vite dev server on 5276
#
# Ctrl-C tears down everything. The LiveKit server starts only if one isn't
# already reachable on `localhost:7880` — re-running the script across a
# manually-managed server is supported.
#
# Env knobs:
#   LIVEKIT_URL          override the URL injected into both browser pages
#                        (default ws://localhost:7880)
#   SKIP_LIVEKIT_SERVER  truthy → don't try to start a Docker server
#   LIVEKIT_IMAGE        override the Docker image tag

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
LIVEKIT_IMAGE="${LIVEKIT_IMAGE:-livekit/livekit-server:latest}"

pids=()
started_container=""
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[livekit-demo] shutting down..."
  for pid in "${pids[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "$started_container" ]]; then
    echo "[livekit-demo] stopping LiveKit container..."
    docker stop "$started_container" >/dev/null 2>&1 || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. LiveKit server — only start if not already up.
if (echo > /dev/tcp/127.0.0.1/7880) 2>/dev/null; then
  echo "[livekit-demo] LiveKit server already reachable on :7880 — reusing"
elif [[ -n "${SKIP_LIVEKIT_SERVER:-}" ]]; then
  echo "[livekit-demo] SKIP_LIVEKIT_SERVER set — expecting external server on :7880" >&2
  echo "[livekit-demo] If nothing is listening, the pages will hang on connect." >&2
else
  if ! command -v docker >/dev/null 2>&1; then
    cat >&2 <<EOF
[livekit-demo] No LiveKit server on :7880, and \`docker\` is not installed.
[livekit-demo] Options:
[livekit-demo]   - install Docker and re-run \`pnpm start\`, or
[livekit-demo]   - run \`livekit-server --dev\` yourself, or
[livekit-demo]   - set LIVEKIT_URL=<your-url> and SKIP_LIVEKIT_SERVER=1.
EOF
    exit 1
  fi
  echo "[livekit-demo] starting LiveKit dev server via Docker..."
  started_container="livekit-demo-$$"
  docker run -d --rm --name "$started_container" \
    -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
    "$LIVEKIT_IMAGE" \
    --dev --bind 0.0.0.0 >/dev/null
  # Wait for :7880 to accept connections.
  for _ in $(seq 1 40); do
    if (echo > /dev/tcp/127.0.0.1/7880) 2>/dev/null; then break; fi
    sleep 0.5
  done
  if ! (echo > /dev/tcp/127.0.0.1/7880) 2>/dev/null; then
    echo "[livekit-demo] LiveKit container failed to come up on :7880" >&2
    docker logs "$started_container" >&2 || true
    exit 1
  fi
  echo "[livekit-demo] LiveKit server up on :7880 (container $started_container)"
fi

# 2. Token service.
echo "[livekit-demo] starting token-service on :9091..."
(cd "$ROOT" && exec pnpm run token-service) &
pids+=("$!")
for _ in $(seq 1 40); do
  if (echo > /dev/tcp/127.0.0.1/9091) 2>/dev/null; then break; fi
  sleep 0.25
done
if ! (echo > /dev/tcp/127.0.0.1/9091) 2>/dev/null; then
  echo "[livekit-demo] token-service failed to come up on :9091" >&2
  exit 1
fi

echo
echo "[livekit-demo] ==================================================================="
echo "[livekit-demo] LiveKit server : ws://localhost:7880"
echo "[livekit-demo] token-service  : http://localhost:9091/token"
echo "[livekit-demo] server page    : http://localhost:5275"
echo "[livekit-demo] client page    : http://localhost:5276"
echo "[livekit-demo] ==================================================================="
echo

# 3 & 4. Vite dev servers in parallel.
(cd "$ROOT" && exec pnpm run server-page) &
pids+=("$!")
(cd "$ROOT" && exec pnpm run client-page) &
pids+=("$!")

wait -n 2>/dev/null || wait
