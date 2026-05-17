#!/usr/bin/env bash
# Launch all three pieces of the merged p2p-demo:
#   1. Node libp2p Circuit Relay v2 (`relay/server.ts` via tsx)
#   2. server-page Vite dev server on 5175
#   3. client-page Vite dev server on 5176
#
# Boots the relay first, parses its multiaddr from stdout, exports it as
# VITE_RELAY_MULTIADDR, then boots the two Vite dev servers in parallel.
# Ctrl-C tears down all three.
#
# Env knobs:
#   RELAY_PORT — port for the relay's WS listener (default 9090).
#   GROUP_ID   — default group id injected as VITE_GROUP_ID (default "demo").
#                Pages can override per-tab with a URL fragment, e.g. "#alpha".

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
RELAY_PORT="${RELAY_PORT:-9090}"
GROUP_ID="${GROUP_ID:-demo}"
RELAY_LOG="$(mktemp -t p2p-demo-relay.XXXXXX.log)"

pids=()
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[p2p-demo] shutting down..."
  for pid in "${pids[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  rm -f "$RELAY_LOG"
}
trap cleanup EXIT INT TERM

echo "[p2p-demo] starting relay on port $RELAY_PORT..."
# Direct file redirection (no pipeline) so $! is the actual process, not a
# tee at the end of a pipe. Tail -F shows live output to the user.
(
  cd "$ROOT"
  RELAY_PORT="$RELAY_PORT" exec pnpm run relay
) >"$RELAY_LOG" 2>&1 &
relay_pid=$!
pids+=("$relay_pid")

tail -n +1 -F "$RELAY_LOG" 2>/dev/null &
pids+=("$!")

multiaddr=""
for _ in $(seq 1 60); do
  # Early-fail on common fatal patterns.
  if grep -qE "EADDRINUSE|UnsupportedListenAddressesError|Error: " "$RELAY_LOG" 2>/dev/null; then
    echo "[p2p-demo] relay reported an error (see above); aborting" >&2
    exit 1
  fi
  if [[ -s "$RELAY_LOG" ]]; then
    multiaddr=$(grep -Eo '/ip4/[^[:space:]]+/p2p/[A-Za-z0-9]+' "$RELAY_LOG" | head -n1 || true)
    [[ -n "$multiaddr" ]] && break
  fi
  if ! kill -0 "$relay_pid" 2>/dev/null; then
    echo "[p2p-demo] relay exited before printing a multiaddr; see $RELAY_LOG" >&2
    exit 1
  fi
  sleep 0.5
done

if [[ -z "$multiaddr" ]]; then
  echo "[p2p-demo] timed out waiting for the relay's multiaddr" >&2
  exit 1
fi

echo
echo "[p2p-demo] ==================================================================="
echo "[p2p-demo] relay multiaddr: $multiaddr"
echo "[p2p-demo] default group:   $GROUP_ID"
echo "[p2p-demo] server page:     http://localhost:5175 (override group: append #<id>)"
echo "[p2p-demo] client page:     http://localhost:5176 (override group: append #<id>)"
echo "[p2p-demo] ==================================================================="
echo

export VITE_RELAY_MULTIADDR="$multiaddr"
export VITE_GROUP_ID="$GROUP_ID"

(cd "$ROOT" && exec pnpm run server-page) &
pids+=("$!")
(cd "$ROOT" && exec pnpm run client-page) &
pids+=("$!")

# Block until any child exits, then cleanup kicks in via trap.
wait -n 2>/dev/null || wait
