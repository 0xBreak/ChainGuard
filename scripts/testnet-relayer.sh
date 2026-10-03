#!/usr/bin/env bash
# Start/stop the relayer for the testnet deployment (keys from .env). Status: http://localhost:8788/status
# Usage: scripts/testnet-relayer.sh [start|stop|logs]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/.testnet"; mkdir -p "$RUN"
case "${1:-start}" in
  stop) [ -f "$RUN/relayer.pid" ] && kill "$(cat "$RUN/relayer.pid")" 2>/dev/null; rm -f "$RUN/relayer.pid"; echo stopped ;;
  logs) tail -f "$RUN/relayer.log" ;;
  start)
    set -a; . "$ROOT/.env"; set +a
    [ -f "$RUN/relayer.pid" ] && kill "$(cat "$RUN/relayer.pid")" 2>/dev/null || true
    (cd "$ROOT/relayer" && MODE=testnet STATUS_PORT=8788 POLL_MS=${POLL_MS:-2000} exec bun src/index.ts) >"$RUN/relayer.log" 2>&1 </dev/null &
    echo $! >"$RUN/relayer.pid"
    echo "relayer started (pid $(cat "$RUN/relayer.pid")), status http://localhost:8788/status, log .testnet/relayer.log" ;;
esac
