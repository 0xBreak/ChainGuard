#!/usr/bin/env bash
# Verify the testnet deployment on Blockscout explorers (no API key needed).
# Usage: scripts/verify.sh   (optionally ETHERSCAN_API_KEY=… for Arbiscan too)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT/contracts"
declare -A RPC=([421614]=https://sepolia-rollup.arbitrum.io/rpc [46630]=https://rpc.testnet.chain.robinhood.com/rpc)
declare -A SCOUT=([421614]=https://arbitrum-sepolia.blockscout.com/api/ [46630]=https://explorer.testnet.chain.robinhood.com/api/)
declare -A SRC=([registry]=src/ComplianceRegistry.sol:ComplianceRegistry [guard]=src/ComplianceGuard.sol:ComplianceGuard [usdg]=src/tokens/MockUSDG.sol:MockUSDG [stock]=src/tokens/MockStockToken.sol:MockStockToken)
for chain in 421614 46630; do
  for key in registry guard usdg stock; do
    addr=$(jq -r ".$key" "deployments/testnet/$chain.json")
    echo "== $chain $key $addr"
    forge verify-contract "$addr" "${SRC[$key]}" --chain "$chain" --rpc-url "${RPC[$chain]}" --guess-constructor-args \
      --verifier blockscout --verifier-url "${SCOUT[$chain]}" --watch 2>&1 | grep -E "Contract successfully verified|already verified|Error|error|Pass" | head -3 \
      | tee /dev/stderr | grep -q "Too many requests" && \
      forge verify-contract "$addr" "${SRC[$key]}" --chain "$chain" --rpc-url "${RPC[$chain]}" --guess-constructor-args \
        --verifier sourcify --watch 2>&1 | grep -iE "verified|match|error" | head -2  # Blockscout picks Sourcify matches up
    if [ "$chain" = 421614 ] && [ -n "${ETHERSCAN_API_KEY:-}" ]; then
      forge verify-contract "$addr" "${SRC[$key]}" --chain "$chain" --rpc-url "${RPC[$chain]}" --guess-constructor-args \
        --etherscan-api-key "$ETHERSCAN_API_KEY" --watch 2>&1 | grep -E "successfully verified|already verified|Error" | head -2
    fi
  done
done
