#!/usr/bin/env bash
# Deploy the ChainGuard stack to one chain and record its start block.
# Usage: scripts/deploy.sh <tag> <rpc-url>
# Env:   PRIVATE_KEY, COMMITTEE, RELAYER [, THRESHOLD, MIN_STAKE, REWARD_SEED]
set -euo pipefail
TAG=${1:?tag (local|testnet)}
RPC=${2:?rpc url}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/contracts"

CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
DEPLOY_TAG=$TAG forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow ${FORGE_FLAGS:-} 1>&2

# Arbitrum's block.number is the L1 block, so take the real L2 block from the receipts.
RUN="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
START=$(cast to-dec "$(jq -r '.receipts[0].blockNumber' "$RUN")")
OUT="deployments/$TAG/$CHAIN_ID.json"
jq --argjson b "$START" '. + {startBlock: $b}' "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
echo "deployed chain $CHAIN_ID from block $START -> contracts/$OUT" >&2
