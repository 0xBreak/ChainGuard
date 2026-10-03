// ChainGuard relayer: mirrors registry flags between chains and serves a small /status endpoint.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  nonceManager,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryAbi } from "../../shared/abis";
import { CHAINS, CHAIN_KEYS, STATUSES, isActiveStatus, type ChainKey, type Deployment, type Mode } from "../../shared/chains";

const MODE = (process.env.MODE ?? "local") as Mode;
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const PORT = Number(process.env.STATUS_PORT ?? 8787);
const ONCE = process.argv.includes("--once") || process.env.ONCE === "1";
const MAX_RANGE = 2000n;
const RPC_ENV: Record<ChainKey, string> = { arbitrum: "ARB_SEPOLIA_RPC", robinhood: "ROBINHOOD_RPC" };
const WATCHED = new Set(["AddressFlagged", "FlagConfirmed", "FlagRejected", "FlagExpired", "AddressCleared"]);

const pk = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
if (!pk) throw new Error("RELAYER_PRIVATE_KEY is required");
const account = privateKeyToAccount(pk, { nonceManager });

interface Node {
  key: ChainKey;
  name: string;
  chainId: number;
  dep: Deployment;
  pub: PublicClient;
  wallet: WalletClient<ReturnType<typeof http>, Chain, Account>;
  nextBlock: bigint;
  head: bigint;
  lastPollAt: number;
  lastMirrorAt: number;
  mirrorsSent: number;
  errors: number;
}

interface MirrorRecord {
  account: Address;
  from: ChainKey;
  to: ChainKey;
  status: string;
  round: number;
  txHash: Hex;
  at: number;
  latencyMs: number | null;
}

const recent: MirrorRecord[] = [];

type FlagSnapshot = {
  category: number;
  severity: number;
  status: number;
  round: number;
  sourceChainId: bigint;
  reporter: Address;
  timestamp: bigint;
  evidenceHash: Hex;
};

function loadDeployment(chainId: number): Deployment {
  const path = resolve(import.meta.dir, `../../contracts/deployments/${MODE}/${chainId}.json`);
  if (!existsSync(path)) throw new Error(`missing deployment ${path} — run scripts/deploy.sh first`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const nodes: Node[] = CHAIN_KEYS.map((key) => {
  const meta = CHAINS[key];
  const rpc = process.env[RPC_ENV[key]] || meta.rpc[MODE];
  const chain = defineChain({
    id: meta.chainId,
    name: meta.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const dep = loadDeployment(meta.chainId);
  return {
    key,
    name: meta.name,
    chainId: meta.chainId,
    dep,
    pub: createPublicClient({ chain, transport: http(rpc), pollingInterval: 500 }) as PublicClient,
    wallet: createWalletClient({ chain, transport: http(rpc), account }),
    nextBlock: BigInt(dep.startBlock ?? 0),
    head: 0n,
    lastPollAt: 0,
    lastMirrorAt: 0,
    mirrorsSent: 0,
    errors: 0,
  };
});

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function readFlag(node: Node, who: Address): Promise<FlagSnapshot> {
  return (await node.pub.readContract({
    address: node.dep.registry,
    abi: registryAbi,
    functionName: "getFlagDetails",
    args: [who],
  })) as FlagSnapshot;
}

interface Pending {
  src: Node;
  snap: FlagSnapshot;
  observedAt: number | null;
}
const pending = new Map<ChainKey, Map<Address, Pending>>(CHAIN_KEYS.map((k) => [k, new Map()]));
const BATCH = Number(process.env.MIRROR_BATCH ?? 100);

/** Queue the source chain's view of `who` for every other chain, if it is governed there. */
function enqueue(src: Node, who: Address, snap: FlagSnapshot, observedAt: number | null) {
  if (Number(snap.sourceChainId) !== src.chainId || snap.status === 0) return; // mirrors are never re-broadcast
  for (const dst of nodes) {
    if (dst === src) continue;
    const q = pending.get(dst.key)!;
    const prev = q.get(who);
    q.set(who, { src, snap, observedAt: prev?.observedAt ?? observedAt });
  }
}

async function inParallel<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j]);
    }
  }));
  return out;
}

/** Send one mirrorBatch with whatever is queued for `dst` and still out of date there. */
async function flush(dst: Node) {
  const q = pending.get(dst.key)!;
  if (q.size === 0) return;
  const take = [...q.entries()].slice(0, BATCH);
  take.forEach(([who]) => q.delete(who));

  const current = await inParallel(take, 16, ([who]) => readFlag(dst, who));
  const todo = take.filter(([, p], i) => {
    const d = current[i];
    const f = p.snap;
    if (d.sourceChainId === f.sourceChainId) return f.round > d.round || (f.round === d.round && f.status > d.status);
    return !isActiveStatus(d.status); // never clobber a live flag governed elsewhere
  });
  if (todo.length === 0) return;

  const hash = await dst.wallet.writeContract({
    address: dst.dep.registry,
    abi: registryAbi,
    functionName: "mirrorBatch",
    args: [
      todo.map(([who, { snap: f }]) => ({
        account: who,
        sourceChainId: f.sourceChainId,
        round: f.round,
        status: f.status,
        category: f.category,
        severity: f.severity,
        reporter: f.reporter,
        timestamp: f.timestamp,
        evidenceHash: f.evidenceHash,
      })),
    ],
  });
  const receipt = await dst.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`mirrorBatch reverted ${hash}`);

  const now = Date.now();
  dst.lastMirrorAt = now;
  dst.mirrorsSent += todo.length;
  for (const [who, p] of todo) {
    recent.unshift({
      account: who,
      from: p.src.key,
      to: dst.key,
      status: STATUSES[p.snap.status],
      round: p.snap.round,
      txHash: hash,
      at: now,
      latencyMs: p.observedAt ? now - p.observedAt : null,
    });
  }
  recent.length = Math.min(recent.length, 50);
  const lat = todo.map(([, p]) => p.observedAt).filter((x): x is number => !!x);
  log(
    `[${todo[0][1].src.key} -> ${dst.key}] mirrored ${todo.length}` +
      (todo.length === 1 ? ` ${STATUSES[todo[0][1].snap.status]} ${todo[0][0]}` : "") +
      (lat.length ? ` in ${((now - Math.min(...lat)) / 1000).toFixed(1)}s` : "") +
      (q.size ? ` (${q.size} queued)` : ""),
  );
}

async function flusher(dst: Node) {
  for (;;) {
    try {
      await flush(dst);
    } catch (e) {
      dst.errors++;
      log(`[${dst.key}] mirror failed:`, (e as Error).message.split("\n")[0]);
    }
    if (pending.get(dst.key)!.size === 0) await new Promise((r) => setTimeout(r, 250));
  }
}

/** Catch up on everything already in the registries (restart-safe, idempotent). */
async function bootstrap(node: Node) {
  const head = await node.pub.getBlockNumber(); // anything after this is picked up by the tail
  const total = (await node.pub.readContract({ address: node.dep.registry, abi: registryAbi, functionName: "flaggedCount" })) as bigint;
  for (let off = 0n; off < total; off += 500n) {
    const [accounts, flags] = (await node.pub.readContract({
      address: node.dep.registry,
      abi: registryAbi,
      functionName: "getFlags",
      args: [off, 500n],
    })) as readonly [readonly Address[], readonly FlagSnapshot[]];
    accounts.forEach((a, i) => enqueue(node, a, flags[i], null));
  }
  node.nextBlock = head + 1n;
  log(`[${node.key}] bootstrapped ${total} flagged addresses, tailing from block ${node.nextBlock}`);
}

async function poll(node: Node) {
  const head = await node.pub.getBlockNumber();
  node.head = head;
  node.lastPollAt = Date.now();
  while (node.nextBlock <= head) {
    const to = node.nextBlock + MAX_RANGE - 1n < head ? node.nextBlock + MAX_RANGE - 1n : head;
    const logs = await node.pub.getContractEvents({
      address: node.dep.registry,
      abi: registryAbi,
      fromBlock: node.nextBlock,
      toBlock: to,
    });
    const touched = new Set<Address>();
    for (const l of logs) {
      const who = (l.args as { account?: Address }).account;
      if (WATCHED.has(l.eventName) && who) touched.add(who);
    }
    const now = Date.now();
    const accounts = [...touched];
    const snaps = await inParallel(accounts, 16, (who) => readFlag(node, who));
    accounts.forEach((who, i) => enqueue(node, who, snaps[i], now));
    node.nextBlock = to + 1n;
  }
}

async function loop(node: Node) {
  for (;;) {
    try {
      await poll(node);
    } catch (e) {
      node.errors++;
      log(`[${node.key}] poll error:`, (e as Error).message.split("\n")[0]);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function status() {
  return {
    mode: MODE,
    relayer: account.address,
    now: Date.now(),
    chains: nodes.map((n) => ({
      key: n.key,
      chainId: n.chainId,
      registry: n.dep.registry,
      head: n.head.toString(),
      lastPollAt: n.lastPollAt,
      lastMirrorAt: n.lastMirrorAt,
      mirrorsSent: n.mirrorsSent,
      queued: pending.get(n.key)!.size,
      errors: n.errors,
    })),
    recent,
  };
}

log(`relayer ${account.address} mode=${MODE}${ONCE ? " (one-shot)" : ` status=http://localhost:${PORT}/status`}`);
for (const n of nodes) {
  const bal = await n.pub.getBalance({ address: account.address });
  log(`[${n.key}] chain ${n.chainId} registry ${n.dep.registry} balance ${Number(bal) / 1e18} ETH`);
}
await Promise.all(nodes.map(bootstrap));

if (ONCE) {
  // One-shot catch-up (cron / GitHub Actions): mirror everything that is out of date, then exit.
  for (const n of nodes) {
    while (pending.get(n.key)!.size > 0) await flush(n);
  }
  const sent = nodes.reduce((a, n) => a + n.mirrorsSent, 0);
  log(`catch-up done: ${sent} flag(s) mirrored, ${nodes.reduce((a, n) => a + n.errors, 0)} error(s)`);
  process.exit(0);
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
    if (new URL(req.url).pathname === "/status") return new Response(JSON.stringify(status()), { headers });
    return new Response("not found", { status: 404, headers });
  },
});

nodes.forEach(loop);
nodes.forEach(flusher);
