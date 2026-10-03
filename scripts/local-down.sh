#!/usr/bin/env bash
# Stop processes started by scripts/local-up.sh.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PIDS="$ROOT/.local/pids"
if [ -f "$PIDS" ]; then
while read -r pid; do kill "$pid" 2>/dev/null; done <"$PIDS"
rm -f "$PIDS"; fi
pkill -f "bun src/index.ts" 2>/dev/null || true
# Wait until the ports are actually free so a following local-up can bind them.
for _ in $(seq 1 50); do
  ss -ltn 2>/dev/null | grep -qE ":(8545|8546|8787)\b" || exit 0
  sleep 0.1
done
echo "warning: ports 8545/8546/8787 still busy" >&2
