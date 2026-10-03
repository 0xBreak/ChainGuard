# ChainGuard — submission text

Copy-paste material for the hackathon form. All numbers below were measured on the live testnet deployment.

## Name
ChainGuard

## Tagline (≤ 100 chars)
An on-chain compliance firewall for stablecoins and tokenized stocks, live on Arbitrum and Robinhood Chain.

## Short description (≤ 280 chars)
Tokenized stocks and stablecoins move freely to hackers, drainers and sanctioned wallets. ChainGuard puts the screening inside the token: a shared on-chain threat registry with 10k+ real addresses, staked reporting, committee governance, and a 4-second sync between Arbitrum and Robinhood Chain.

## Problem
A broker has to screen counterparties by law. An ERC-20 doesn't screen anyone. As stock tokens on Robinhood Chain and stablecoins such as USDG connect regulated finance with DeFi, any address behind a phishing kit, a bridge exploit or an OFAC listing can still receive and trade them. Today the only response is off-chain: an exchange freezes a deposit after the fact. Nothing stops the transfer itself.

## Solution
- **ComplianceRegistry.** A single on-chain list of risky addresses. Each entry has a category (sanctioned, exploit, phishing, mixer, rug pull, scam), a severity from 1 to 3, an evidence hash and URI, the reporter, and governance status.
- **ComplianceGuard.** A transfer hook any token can plug into (via `_update`). Severity 3 reverts the transfer with a readable `AddressBlocked(account, category, severity)`. Severity 1–2 lets it through but emits a `ComplianceWarning`, the "yellow flag" banks use.
- **Staked reporting that resists spam.** Anyone can report an address by staking ETH. Until a 2-of-3 committee confirms it, the flag is only a soft warning, so a griefer can't freeze anyone's funds. Confirmed reports return the stake plus a 20% reward. Rejected reports are slashed: 50% goes to the wrongly accused address and 50% to the reward pool. The flagged address can appeal, the committee can lift the flag, and unresolved reports expire with a refund.
- **Multichain.** One logical registry on Arbitrum Sepolia and Robinhood Chain testnet. A relayer mirrors every flag snapshot with replay, ordering and conflict protection, and only the source chain governs a flag. Measured: **3.95 s** from committee quorum on Arbitrum to the address being blocked on Robinhood Chain. A GitHub Actions job also runs the relayer every few minutes, so sync continues with no server online.
- **Real threat data, no synthetic noise.** 10,232 labelled addresses from public sources: the OFAC SDN list, exploit attributions (Kelp DAO, Bybit, Ronin, Multichain, Nomad…), ScamSniffer, Etherscan phish/hack labels, malicious-contract datasets, the MyEtherWallet darklist, and Tornado Cash pools verified on-chain. 1,033 high-value entries are enforced on-chain through committee batch votes. Every check also queries GoPlus live (SlowMist, BlockSec).

## Demo flow
1. Check the Kelp DAO exploiter: **BLOCKED** on both chains, with its on-chain history and threat-feed matches.
2. Send demo USDG to it on Robinhood Chain. The token reverts with `AddressBlocked(…, EXPLOIT, 3)`. A transfer to a clean address goes through.
3. Check the Bybit exploiter: the feeds know it, the registry doesn't (**KNOWN THREAT**). Click "Report to registry", stake and submit. It starts as a soft warning.
4. Two committee members confirm. The address becomes BLOCKED on Arbitrum and, seconds later, on Robinhood Chain.

## How it's made
- **Contracts.** Solidity 0.8.28, Foundry, OpenZeppelin v5. 26 tests including fuzzing of stake accounting. Batch paths (`flagBatch`, `confirmBatch`, `mirrorBatch`) let feeds be imported for about 176k gas per address.
- **Relayer.** Bun + viem. It tails events on both chains, queues the latest snapshot per address, and sends `mirrorBatch` transactions. Restart-safe through a full registry rescan. There is a live mode and a one-shot mode for cron / GitHub Actions.
- **Threat intel pipeline.** `build-intel` compiles the public feeds into one labelled database. `import-intel` writes it on-chain through committee votes.
- **Frontend.** Vite + React + wagmi/viem. It reads straight from both chains with no backend. It shows a verdict with a plain-language explanation, threat-intel matches, the on-chain timeline, a live event feed, cross-chain sync status read from the chains, a firewall test (faucet, preview, send, forced on-chain revert), staked reporting, a committee desk and a searchable registry.

## Links
- Live site: <VERCEL_URL>
- Code: https://github.com/0xBreak/ChainGuard
- Video: <VIDEO_URL>

## Deployed contracts (verified on Blockscout)

| | Arbitrum Sepolia | Robinhood Chain testnet |
|---|---|---|
| ComplianceRegistry | 0x4FC00B3132F5121978A82D0a0f79f9B79869177b | 0xe65245bC1181e34FD75a13457AD1A0Bb87050F74 |
| ComplianceGuard | 0x02aA4623077e01303Ebd3aA51F6080b944C35F61 | 0x4aAE00651Db7bD38609b8f484E991090981Bba73 |
| USDG (demo) | 0xc986f96a29EDd0A99599A76bf51f771c98dd0eCb | 0x6B65976C2faED7F1c5368408F7EF56432EE4B4BB |
| TSLA Stock Token (demo) | 0x6F7948cf238fDAD86CE9364AF06E0a203df5d035 | 0x97125C80fE5Ed717a341250b87714acda5dA90Dc |

## Trust assumptions (stated honestly)
- The relayer is a single trusted key. Production would use Arbitrum native messaging, Hyperlane or CCIP.
- The committee is fixed at deploy time.
- USDG and TSLA are demo tokens with the standard ERC-20 interface. Real issuers would plug the guard into their own transfer-restriction hooks.
