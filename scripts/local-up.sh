#!/usr/bin/env bash
# Spin up two local chains (blocks are mined per transaction, so an idle stack doesn't grow) (Arbitrum Sepolia + Robinhood Chain IDs), deploy, seed demo flags, start the relayer.
# Usage: scripts/local-up.sh        (stop with scripts/local-down.sh)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/.local"
mkdir -p "$RUN"
"$ROOT/scripts/local-down.sh" 2>/dev/null || true

ARB=http://127.0.0.1:8545
RH=http://127.0.0.1:8546

# Anvil default accounts: 0 deployer, 1-3 committee, 4 relayer, 5 reporter.
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
   0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
   0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
   0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
   0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
   0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba)
addr() { cast wallet address "$1"; }

setsid anvil --port 8545 --chain-id 421614 --gas-limit 120000000 --prune-history 64 >"$RUN/anvil-arb.log" 2>&1 </dev/null & echo $! >>"$RUN/pids"
setsid anvil --port 8546 --chain-id 46630 --gas-limit 120000000 --prune-history 64 >"$RUN/anvil-rh.log" 2>&1 </dev/null & echo $! >>"$RUN/pids"
for url in $ARB $RH; do until cast chain-id --rpc-url $url >/dev/null 2>&1; do sleep 0.2; done; done
for log in anvil-arb anvil-rh; do grep -q "Listening on" "$RUN/$log.log" || { cat "$RUN/$log.log" >&2; exit 1; }; done

export PRIVATE_KEY=${K[0]}
export COMMITTEE="$(addr ${K[1]}),$(addr ${K[2]}),$(addr ${K[3]})"
export RELAYER=$(addr ${K[4]})
export THRESHOLD=2 MIN_STAKE=10000000000000000 REWARD_SEED=1000000000000000000
"$ROOT/scripts/deploy.sh" local $ARB 2>"$RUN/deploy-arb.log"
"$ROOT/scripts/deploy.sh" local $RH 2>"$RUN/deploy-rh.log"

reg() { jq -r .registry "$ROOT/contracts/deployments/local/$1.json"; }
REG_ARB=$(reg 421614); REG_RH=$(reg 46630)
send() { cast send --rpc-url "$1" --private-key "$2" "${@:3}" >/dev/null; }
FLAG="flagAddress(address,uint8,uint8,bytes32,string)"
ev() { cast keccak "$1"; }

# Demo state: one staked report still awaiting the committee (a ScamSniffer-listed drainer, flagged on Robinhood).
echo "seeding a pending report…" >&2
send $RH ${K[5]} $REG_RH "$FLAG" 0x101ce0cedd142f199c9ef61739ae59b6611a0fc0 2 3 "$(ev scamsniffer)" "ScamSniffer: wallet drainer / phishing | https://github.com/scamsniffer/scam-database" --value 0.01ether

(cd "$ROOT/relayer" && MODE=local RELAYER_PRIVATE_KEY=${K[4]} exec bun src/index.ts) >"$RUN/relayer.log" 2>&1 </dev/null &
echo $! >>"$RUN/pids"

# Import public threat feeds (OFAC, exploiters, mixers, ScamSniffer, Etherscan, MEW) through committee batch votes.
# The Bybit exploiter is left out on purpose: it shows up as KNOWN THREAT so visitors can walk it through report -> quorum -> block.
# Default: high-value feeds only (~1k addresses) to keep anvil's memory small; the UI still screens all 10k via the threat DB.
# FULL_IMPORT=1 scripts/local-up.sh imports everything (anvil then needs ~1.5 GB per chain).
SOURCES=${FULL_IMPORT:+ofac,exploits,mixers,contracts,mew,scamsniffer,etherscan}
SOURCES=${SOURCES:-ofac,exploits,mixers,contracts}
(cd "$ROOT/relayer" && MODE=local CHAIN=arbitrum SOURCES=$SOURCES COMMITTEE_KEYS=${K[1]},${K[2]} EXCLUDE=0x47666Fab8bd0Ac7003bce3f5C3585383F09486E2 exec bun src/import-intel.ts) >"$RUN/import.log" 2>&1 </dev/null &
echo $! >>"$RUN/pids"

cat >&2 <<MSG

ChainGuard local stack is up.
  Arbitrum Sepolia (local)  $ARB   registry $REG_ARB
  Robinhood Chain  (local)  $RH   registry $REG_RH
  Relayer status            http://localhost:8787/status   (log: .local/relayer.log)
  Threat-feed import        running in background          (log: .local/import.log)
Next: cd frontend && bun run dev
MSG
