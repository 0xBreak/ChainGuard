# ChainGuard — On-Chain Compliance Firewall for Tokenized Assets

> Real-time fraud & sanctions screening for stablecoins and tokenized securities, enforced inside the token transfer itself, on **Arbitrum Sepolia** and **Robinhood Chain**.

A broker has to screen counterparties by law. ERC-20s don't. Any address tied to phishing, a rug pull or a sanctions list can trade tokenized stocks or USDG freely. ChainGuard adds that check at the token level: a shared on-chain registry of flagged addresses, a transfer hook that enforces it, staked reporting so flags can't be spammed, and a relayer that keeps the registry in sync across chains.

```
            ┌─────────── Arbitrum Sepolia ───────────┐            ┌────────── Robinhood Chain ───────────┐
reporter ──►│ ComplianceRegistry  ◄── committee 2/3  │◄─ relayer ─►│ ComplianceRegistry (mirror + local)  │
  stake     │        ▲ riskOf()                      │   mirrorFlag │        ▲ riskOf()                    │
            │ ComplianceGuard.check(from,to)         │             │ ComplianceGuard.check(from,to)       │
            │        ▲ _update hook                  │             │        ▲ _update hook                │
            │ USDG (demo) · TSLA Stock Token (demo)  │             │ USDG (demo) · TSLA Stock Token (demo)│
            └────────────────────────────────────────┘             └──────────────────────────────────────┘
```

## Threat intelligence (real data, no synthetic noise)

`relayer/src/build-intel.ts` compiles **10,232 labelled addresses** from public sources into `shared/intel/threat-db.json`:

| Source | Addresses | Category |
|---|---|---|
| US Treasury OFAC SDN list (ETH) | 120 | SANCTIONED · 3 |
| Exploit & hack attributions: curated (Kelp DAO, Bybit) + Etherscan labels (Ronin, Multichain, Nomad, BadgerDAO, KyberSwap, …) | 300 | EXPLOIT · 3 |
| Malicious smart contracts and their deployers (Forta labelled datasets) | 611 | PHISHING / EXPLOIT · 3 |
| Etherscan phish/hack label cloud (Forta labelled datasets) | 7,077 | PHISHING · 3 / SCAM · 2 |
| ScamSniffer drainer & phishing blacklist | 2,530 | PHISHING · 3 |
| MyEtherWallet darklist | 652 | PHISHING / SCAM |
| Tornado Cash pools, each verified on-chain via `denomination()` on Ethereum and Arbitrum One | 9 | MIXER · 2 (warn, don't block) |

The data is used in two layers:
- **Enforcement.** `relayer/src/import-intel.ts` writes the database into the registry through committee batch votes (`flagBatch` + `confirmBatch`, about 176k gas per address). The relayer mirrors it with `mirrorBatch`. Locally the default import covers OFAC, exploits, mixers and malicious contracts (~1k addresses, ~200 MB RAM per anvil). `FULL_IMPORT=1` loads all 10k (~1.5 GB per anvil). Either way the UI screens against the full database.
- **Screening.** The UI also checks the full database plus a live **GoPlus** lookup (SlowMist, BlockSec, …). An address that the feeds know but the registry doesn't shows as **KNOWN THREAT**, with a one-click "Report to registry".

Refresh the feeds with `cd relayer && bun src/build-intel.ts`.

## How it works

| Piece | What it does |
|---|---|
| `ComplianceRegistry.sol` | Batch paths for feeds: `flagBatch`, `confirmBatch` (committee) and `mirrorBatch` (relayer; skips stale entries instead of reverting). `Flag { category, severity, status, reporter, stake, evidenceHash, round, sourceChainId, … }` per address. Categories: SANCTIONED, PHISHING, RUGPULL, MIXER, SCAM_REPORTED, EXPLOIT. Severity 1–3. `flagAddress`, `confirmFlag` / `rejectFlag` / `unflagAddress` (committee votes), `fileAppeal`, `expireFlag`, `isFlagged`, `riskOf`, `getFlagDetails`, `getFlags` (paged), `stats`. Emits `AddressFlagged`, `FlagConfirmed`, `FlagRejected`, `AddressCleared`, `FlagMirrored`, … |
| `ComplianceGuard.sol` | `check(from, to, amount)`: severity 3 → `revert AddressBlocked(account, category, severity)`; severity 1–2 → `ComplianceWarning` event, transfer goes through ("yellow flag"). `preview(from, to)` for UIs. |
| `ComplianceGuardedERC20` | Abstract ERC-20 that calls the guard from `_update` (OpenZeppelin v5's replacement for `_beforeTokenTransfer`), so transfers, mints and burns are all screened. `MockUSDG` (6 decimals) and `MockStockToken` (TSLA) inherit it. |
| `relayer/` | Bun + viem. Tails registry events on both chains, reads the source-chain flag snapshot and calls `mirrorFlag` on the other chain. On startup it rescans every flag, so restarts and downtime are safe. Serves `GET /status` for the UI. |
| `frontend/` | Vite + React + wagmi/viem. Reads straight from both chains. There's no backend apart from the optional relayer status. |

### Anti-spam game theory

1. **Stake to flag.** Non-committee reporters lock at least `minStake` ETH.
2. **A pending flag is only a soft warning.** `riskOf` caps a PENDING flag at severity 1, whatever was requested. A griefer can't freeze anyone's funds. All they can buy is a yellow flag, and they pay for it.
3. **Committee quorum (2-of-3 in the demo)** confirms or rejects. A committee member's own flag counts as their confirm vote. One-click actions don't exist: every resolution needs quorum.
4. **Confirmed:** the stake comes back, plus a 20% reward from the reward pool. Full severity applies.
5. **Rejected (false flag):** the stake is slashed. 50% goes to the wrongly flagged address as compensation and 50% funds the reward pool. Self-flagging an alt to farm compensation loses half the stake.
6. **Appeals:** the flagged address calls `fileAppeal(reason)`, and the committee can lift the flag with `unflagAddress` (also quorum).
7. **Liveness:** if the committee never acts, anyone can `expireFlag` after `pendingTtl` (3 days) and the reporter is refunded.

Payouts use pull payments (`withdraw()`), so a reverting recipient can't block resolution.

### Multichain sync

- Each flag has a `sourceChainId`. Only the source chain can vote on or resolve it, and a mirrored copy reverts with `ForeignFlag`.
- The relayer sends full snapshots and they only move forward. A mirror is accepted only if it's a newer round, or the same round with a later status (PENDING → CONFIRMED → CLEARED, PENDING → REJECTED). Replays and out-of-order deliveries revert with `StaleMirror`.
- A mirror never overwrites a live flag governed elsewhere (`MirrorConflict`), which also protects any stake that flag holds.
- Locally the relayer mirrors a flag about 0.5 s after the block that contains it. On testnet the delay is mostly block inclusion on the destination chain.

## Live testnet deployment

| Contract | Arbitrum Sepolia (421614) | Robinhood Chain testnet (46630) |
|---|---|---|
| ComplianceRegistry | [`0x4FC00B3132F5121978A82D0a0f79f9B79869177b`](https://sepolia.arbiscan.io/address/0x4FC00B3132F5121978A82D0a0f79f9B79869177b) | [`0xe65245bC1181e34FD75a13457AD1A0Bb87050F74`](https://explorer.testnet.chain.robinhood.com/address/0xe65245bC1181e34FD75a13457AD1A0Bb87050F74) |
| ComplianceGuard | [`0x02aA4623077e01303Ebd3aA51F6080b944C35F61`](https://sepolia.arbiscan.io/address/0x02aA4623077e01303Ebd3aA51F6080b944C35F61) | [`0x4aAE00651Db7bD38609b8f484E991090981Bba73`](https://explorer.testnet.chain.robinhood.com/address/0x4aAE00651Db7bD38609b8f484E991090981Bba73) |
| USDG (demo) | [`0xc986f96a29EDd0A99599A76bf51f771c98dd0eCb`](https://sepolia.arbiscan.io/address/0xc986f96a29EDd0A99599A76bf51f771c98dd0eCb) | [`0x6B65976C2faED7F1c5368408F7EF56432EE4B4BB`](https://explorer.testnet.chain.robinhood.com/address/0x6B65976C2faED7F1c5368408F7EF56432EE4B4BB) |
| TSLA Stock Token (demo) | [`0x6F7948cf238fDAD86CE9364AF06E0a203df5d035`](https://sepolia.arbiscan.io/address/0x6F7948cf238fDAD86CE9364AF06E0a203df5d035) | [`0x97125C80fE5Ed717a341250b87714acda5dA90Dc`](https://explorer.testnet.chain.robinhood.com/address/0x97125C80fE5Ed717a341250b87714acda5dA90Dc) |

- Committee (2-of-3): `0xD843CBe0bdeE3E884Fd32cE4942219830D5944DA`, `0xC264A0D0674e3d71740274B8F7E12f4a960ba1d5`, `0x7e1253582598eEa174Ce6258798932577d156AF3`. Relayer: `0x31436123d55F4B00cc3a36D172c477D63Ca667C5`.
- 1,033 high-value threats are imported (OFAC, exploits, mixers, malicious contracts) and mirrored to both chains. The Bybit exploiter is deliberately not imported, so it can be used to demo the report flow.
- Measured on testnet: from committee quorum on Arbitrum Sepolia to the address being blocked on Robinhood Chain took **3.95 s**.
- All contracts are verified on Blockscout ([Arbitrum Sepolia](https://arbitrum-sepolia.blockscout.com/address/0x4FC00B3132F5121978A82D0a0f79f9B79869177b), [Robinhood Chain](https://explorer.testnet.chain.robinhood.com/address/0xe65245bC1181e34FD75a13457AD1A0Bb87050F74)). Re-run with `scripts/verify.sh`.

### Hosting
- **Site.** Deploy the repo root on Vercel. `vercel.json` builds `frontend` in testnet mode. The public build doesn't need the relayer: sync status is read from both chains.
- **Relayer, always on and free.** `.github/workflows/relayer.yml` runs `bun src/index.ts --once` every ~5 minutes on GitHub Actions. Add the repository secret `RELAYER_PRIVATE_KEY`. For ~4 s sync during a live demo, also run `scripts/testnet-relayer.sh start` locally (status on :8788). The two modes are safe to run together.
- **Local view of the testnet deployment.** `cd frontend && bun run dev:testnet`.

## Run it locally (two chains, one command)

Requires Foundry, Bun and jq.

```bash
(cd relayer && bun install) && (cd frontend && bun install)
scripts/local-up.sh            # 2 anvil chains (421614, 46630), deploy, start relayer, import ~1k high-value threats (FULL_IMPORT=1 for all 10k)
cd frontend && bun run dev     # http://localhost:5173
scripts/local-down.sh          # stop everything
```

In local mode the wallet menu has **dev accounts** (Committee #1–3, Reporter, Trader) so you can demo without MetaMask.

## Deploy to testnets

```bash
cp .env.example .env           # deployer key, 3 committee addresses, relayer address
scripts/deploy-testnet.sh      # deploys to Arbitrum Sepolia + Robinhood Chain, writes contracts/deployments/testnet/*.json
cd relayer && MODE=testnet RELAYER_PRIVATE_KEY=0x… bun src/index.ts
# import threat feeds (start with the high-value sources to save test ETH)
cd relayer && MODE=testnet CHAIN=arbitrum COMMITTEE_KEYS=0xk1,0xk2 SOURCES=ofac,exploits,mixers,contracts LIMIT=1000 bun src/import-intel.ts
cd frontend && bun run dev:testnet
```

The deployer and the relayer each need a little ETH on both chains. Faucets: Arbitrum Sepolia (bridge Sepolia ETH or use a faucet), Robinhood Chain: https://faucet.testnet.chain.robinhood.com. Committee members only need gas on the chain where they vote.

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | https://sepolia-rollup.arbitrum.io/rpc | https://sepolia.arbiscan.io |
| Robinhood Chain testnet | 46630 | https://rpc.testnet.chain.robinhood.com/rpc | https://explorer.testnet.chain.robinhood.com |

## 3-minute demo script

The site has a built-in walkthrough ("New here?"). The same flow by hand:

1. **Screen a real hacker.** Click *Kelp DAO exploiter* → **BLOCKED**, EXPLOIT / severity 3, a SlowMist hit via GoPlus, and a history showing it flagged on Arbitrum and *synced* to Robinhood.
2. **Other verdicts.** *OFAC-sanctioned* → BLOCKED (SANCTIONED). *Tornado Cash 1 ETH* → WARNING (MIXER, allowed with a warning). *vitalik.eth* → CLEAN.
3. **Known but not enforced.** *Bybit exploiter* is deliberately left out of the local import, so it shows **KNOWN THREAT**. Click *Report to registry* and the form is prefilled. As *Reporter*, stake and submit. The address only gets a soft warning while pending.
4. **Quorum.** As *Committee #1* and then *Committee #2*, click *Committee: confirm* on the verdict. The badge turns BLOCKED and, seconds later, *synced* on Robinhood.
5. **Firewall.** As *Trader*: Robinhood → Faucet → send USDG to Bybit → reverts with `AddressBlocked … EXPLOIT (severity 3)`. Sending to Tornado passes with a yellow flag, and sending to vitalik.eth passes. Tick *broadcast even if simulation fails* to put the revert on-chain.
6. **Game theory.** A false report gets rejected by the committee: the reporter is slashed and the accused address can withdraw half the stake. A confirmed reporter withdraws stake + 20%.

## Repo layout

```
contracts/   Foundry: src/ (Registry, Guard, tokens), test/ (26 tests incl. fuzz), script/Deploy.s.sol
relayer/     Bun + viem: relayer (batched mirroring, /status), build-intel (feeds → DB), import-intel (DB → registry)
frontend/    Vite + React + wagmi/viem dashboard
shared/      chain metadata, generated ABIs (scripts/export-abi.sh), threat intel + compiled threat-db.json
scripts/     local-up / local-down / deploy / deploy-testnet / export-abi
```

## Trust assumptions & limits (hackathon scope)

- The relayer is a single trusted key (`setRelayer`). Production would use a cross-chain messaging layer such as Arbitrum native messaging, Hyperlane or CCIP, so mirrored flags carry a proof instead of a signature.
- The committee and its threshold are fixed at deploy time. Rotating them would need a governance step.
- USDG and the Stock Token are demo mocks with the same ERC-20 interface. The real assets would integrate through their issuer's transfer-restriction hook.
- Evidence is stored as a hash on-chain and the URI is emitted in the event. Nothing is pinned.
