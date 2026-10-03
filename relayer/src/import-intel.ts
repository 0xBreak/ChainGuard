// Import the compiled threat database (shared/intel/threat-db.json) into a ChainGuard registry via committee batch votes.
// The relayer then mirrors everything to the other chain.
//
// Env: MODE=local|testnet  CHAIN=arbitrum|robinhood  COMMITTEE_KEYS=0xk1,0xk2[,…] (at least `threshold` keys)
//      SOURCES=ofac,exploits,mixers,contracts,mew,scamsniffer,etherscan (order = priority)  LIMIT=max addresses  BATCH=per tx
//      EXCLUDE=0xabc,… (keep these off-chain, e.g. to demo the report flow)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, nonceManager, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryAbi } from "../../shared/abis";
import { CHAINS, CATEGORIES, isActiveStatus, type ChainKey, type Deployment, type Mode } from "../../shared/chains";
import type { ThreatDb } from "../../shared/intel";

const MODE = (process.env.MODE ?? "local") as Mode;
const CHAIN = (process.env.CHAIN ?? "arbitrum") as ChainKey;
const ORDER = (process.env.SOURCES ?? "ofac,exploits,mixers,contracts,mew,scamsniffer,etherscan").split(",");
const EXCLUDE = new Set((process.env.EXCLUDE ?? "").toLowerCase().split(",").filter(Boolean));
const LIMIT = Number(process.env.LIMIT ?? Infinity);
const BATCH = Number(process.env.BATCH ?? 80);
const keys = (process.env.COMMITTEE_KEYS ?? "").split(",").filter(Boolean) as Hex[];
if (keys.length === 0) throw new Error("COMMITTEE_KEYS is required");

const root = resolve(import.meta.dir, "../..");
const db: ThreatDb = JSON.parse(readFileSync(`${root}/shared/intel/threat-db.json`, "utf8"));
const meta = CHAINS[CHAIN];
const rpc = process.env[CHAIN === "arbitrum" ? "ARB_SEPOLIA_RPC" : "ROBINHOOD_RPC"] || meta.rpc[MODE];
const dep: Deployment = JSON.parse(readFileSync(`${root}/contracts/deployments/${MODE}/${meta.chainId}.json`, "utf8"));
const chain = defineChain({ id: meta.chainId, name: meta.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 });
const members = keys.map((k) => createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(k, { nonceManager }) }));
const reg = { address: dep.registry, abi: registryAbi } as const;

interface Item {
  address: Address;
  category: number;
  severity: number;
  evidence: string;
}

// Pick addresses source by source in priority order; each uses its strongest record across all feeds.
const picked = new Map<string, Item>();
for (const id of ORDER) {
  const src = db.sources.findIndex((s) => s.id === id);
  if (src < 0) throw new Error(`unknown source ${id}`);
  for (const [addr, records] of Object.entries(db.entries)) {
    if (picked.size >= LIMIT) break;
    if (picked.has(addr) || EXCLUDE.has(addr) || !records.some((r) => r[0] === src)) continue;
    const [s, category, severity, label, url] = records[0];
    picked.set(addr, { address: getAddress(addr), category, severity, evidence: `${label} | ${url ?? db.sources[s].url}` });
  }
}

const [threshold, committee] = await Promise.all([pub.readContract({ ...reg, functionName: "threshold" }), pub.readContract({ ...reg, functionName: "getCommittee" })]);
const voters = members.filter((m) => committee.some((c) => c.toLowerCase() === m.account.address.toLowerCase()));
if (voters.length < threshold) throw new Error(`need ${threshold} committee keys, got ${voters.length}`);

// Skip anything already live (makes the import resumable).
const all = [...picked.values()];
const todo: Item[] = [];
for (let i = 0; i < all.length; i += 200) {
  const chunk = all.slice(i, i + 200);
  const flags = await Promise.all(chunk.map((c) => pub.readContract({ ...reg, functionName: "getFlagDetails", args: [c.address] })));
  chunk.forEach((c, j) => !isActiveStatus(flags[j].status) && todo.push(c));
}
const byCat = todo.reduce<Record<string, number>>((a, c) => ((a[CATEGORIES[c.category]] = (a[CATEGORIES[c.category]] ?? 0) + 1), a), {});
console.log(`importing ${todo.length}/${all.length} addresses to ${meta.name} ${dep.registry} (quorum ${threshold})`, byCat);

async function waves(label: string, send: (chunk: Item[]) => Promise<Hex>) {
  const chunks: Item[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) chunks.push(todo.slice(i, i + BATCH));
  let done = 0;
  // Keep a few transactions in flight; the nonce manager orders them.
  for (let i = 0; i < chunks.length; i += 4) {
    const group = chunks.slice(i, i + 4);
    const hashes = await Promise.all(group.map(send));
    const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
    receipts.forEach((r, j) => {
      if (r.status !== "success") throw new Error(`${label} tx reverted ${hashes[j]}`);
      done += group[j].length;
    });
    console.log(`${label}: ${done}/${todo.length}`);
  }
}

const [first, ...rest] = voters;
await waves("flag   ", (chunk) =>
  first.writeContract({
    ...reg,
    functionName: "flagBatch",
    args: [chunk.map((c) => c.address), chunk.map((c) => c.category), chunk.map((c) => c.severity), chunk.map((c) => c.evidence)],
  }),
);
for (const m of rest.slice(0, threshold - 1)) {
  await waves("confirm", (chunk) => m.writeContract({ ...reg, functionName: "confirmBatch", args: [chunk.map((c) => c.address)] }));
}
console.log("import complete");
