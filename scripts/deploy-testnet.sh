#!/usr/bin/env bash
# Deploy ChainGuard to Arbitrum Sepolia and Robinhood Chain testnet.
# Env (see .env.example): PRIVATE_KEY, COMMITTEE, RELAYER [, THRESHOLD, MIN_STAKE, REWARD_SEED, ARB_SEPOLIA_RPC, ROBINHOOD_RPC]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
: "${PRIVATE_KEY:?}" "${COMMITTEE:?}" "${RELAYER:?}"
export MIN_STAKE=${MIN_STAKE:-1000000000000000}      # 0.001 ETH
export REWARD_SEED=${REWARD_SEED:-5000000000000000}  # 0.005 ETH per chain
ARB=${ARB_SEPOLIA_RPC:-https://sepolia-rollup.arbitrum.io/rpc}
RH=${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com/rpc}

DEPLOYER=$(cast wallet address "$PRIVATE_KEY")
for rpc in "$ARB" "$RH"; do
  echo "chain $(cast chain-id --rpc-url "$rpc"): deployer $DEPLOYER $(cast balance --ether --rpc-url "$rpc" "$DEPLOYER") ETH, relayer $(cast balance --ether --rpc-url "$rpc" "$RELAYER") ETH"
done
"$ROOT/scripts/deploy.sh" testnet "$ARB"
"$ROOT/scripts/deploy.sh" testnet "$RH"
"$ROOT/scripts/export-abi.sh"
cat <<MSG
Deployed. Next:
  cd relayer && MODE=testnet RELAYER_PRIVATE_KEY=0x… bun src/index.ts
  cd frontend && bun run dev:testnet
MSG
