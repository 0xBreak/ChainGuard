import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  formatEther,
  getAddress,
  isAddress,
  pad,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { guardAbi, registryAbi, tokenAbi } from "../../../shared/abis";
import { CATEGORIES, STATUSES, isActiveStatus } from "../../../shared/chains";
import { NET_LIST, netById, type Net } from "../config";

export { CATEGORIES, STATUSES, isActiveStatus };

const guardErrors = guardAbi.filter((x) => x.type === "error");
/** Token ABI plus the guard's errors, so reverts bubbling up from the hook decode cleanly. */
export const guardedTokenAbi = [...tokenAbi, ...guardErrors] as const;
const eventAbi = [...registryAbi, ...guardAbi].filter((x): x is AbiEvent & (typeof registryAbi)[number] => x.type === "event");

export interface Flag {
  category: number;
  severity: number;
  status: number;
  confirmVotes: number;
  rejectVotes: number;
  clearVotes: number;
  round: number;
  sourceChainId: bigint;
  reporter: Address;
  timestamp: bigint;
  resolvedAt: bigint;
  stake: bigint;
  evidenceHash: Hex;
}

export interface ChainVerdict {
  net: Net;
  flag: Flag | null;
  category: number;
  severity: number; // effective, as the guard enforces it
}

export type Verdict = "CLEAN" | "WARNING" | "BLOCKED";

export interface CheckResult {
  address: Address;
  verdict: Verdict;
  category: number;
  severity: number;
  chains: ChainVerdict[];
  primary: ChainVerdict | null; // chain that governs the active flag
}

export const ready = (net: Net) => net.dep !== null;

/** Parse user input into a checksummed address (any casing accepted), or null. */
export const toAddr = (s: string): Address | null => {
  const t = s.trim();
  return isAddress(t, { strict: false }) ? getAddress(t.toLowerCase()) : null;
};
export const NETS_READY = NET_LIST.filter(ready);

export async function readFlag(net: Net, who: Address): Promise<Flag> {
  return (await net.client.readContract({
    address: net.dep!.registry,
    abi: registryAbi,
    functionName: "getFlagDetails",
    args: [who],
  })) as Flag;
}

export async function checkAddress(who: Address): Promise<CheckResult> {
  const chains = await Promise.all(
    NETS_READY.map(async (net): Promise<ChainVerdict> => {
      const [flag, [category, severity]] = await Promise.all([
        readFlag(net, who),
        net.client.readContract({ address: net.dep!.registry, abi: registryAbi, functionName: "riskOf", args: [who] }),
      ]);
      return { net, flag: flag.status === 0 ? null : flag, category, severity };
    }),
  );
  const worst = chains.reduce<ChainVerdict | null>((a, c) => (!a || c.severity > a.severity ? c : a), null);
  const severity = worst?.severity ?? 0;
  const verdict: Verdict = severity >= 3 ? "BLOCKED" : severity > 0 ? "WARNING" : "CLEAN";
  const active = chains.find((c) => c.flag && isActiveStatus(c.flag.status));
  const primary = active?.flag ? (chains.find((c) => c.net.chainId === Number(active.flag!.sourceChainId)) ?? active) : null;
  return { address: who, verdict, category: worst?.category ?? 0, severity, chains, primary };
}

// ---------------------------------------------------------------- events

export interface ChainEvent {
  id: string;
  net: Net;
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
  time: number | null; // ms
}

const blockTimes = new Map<string, number>();
async function blockTime(net: Net, n: bigint): Promise<number> {
  const k = `${net.chainId}:${n}`;
  const hit = blockTimes.get(k);
  if (hit) return hit;
  const b = await net.client.getBlock({ blockNumber: n });
  const t = Number(b.timestamp) * 1000;
  if (blockTimes.size > 5000) blockTimes.clear(); // bounded cache for long-running tabs
  blockTimes.set(k, t);
  return t;
}

function decode(net: Net, log: Log): ChainEvent | null {
  try {
    const d = decodeEventLog({ abi: eventAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return {
      id: `${net.chainId}:${log.transactionHash}:${log.logIndex}`,
      net,
      name: d.eventName,
      args: (d.args ?? {}) as Record<string, unknown>,
      blockNumber: log.blockNumber!,
      txHash: log.transactionHash!,
      logIndex: log.logIndex!,
      time: null,
    };
  } catch {
    return null;
  }
}

async function withTimes(events: ChainEvent[]) {
  await Promise.all(events.map(async (e) => (e.time = await blockTime(e.net, e.blockNumber).catch(() => null))));
  return events;
}

// Every registry event whose first indexed topic is the flagged account.
const ACCOUNT_EVENTS = registryAbi
  .filter((x): x is Extract<(typeof registryAbi)[number], { type: "event" }> => x.type === "event")
  .filter((e) => ["AddressFlagged", "FlagVote", "FlagConfirmed", "FlagRejected", "FlagExpired", "AppealFiled", "AddressCleared", "FlagMirrored"].includes(e.name))
  .map((e) => toEventSelector(e as AbiEvent));

async function rawLogs(net: Net, address: Address[], topics: (Hex | Hex[] | null)[], from: bigint, to: bigint): Promise<Log[]> {
  return (await net.client.request({
    method: "eth_getLogs",
    params: [{ address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
  } as never)) as Log[];
}

/** Logs over [from, to], halving the window when an RPC rejects a wide range or the response is too large. */
async function rangedLogs(net: Net, address: Address[], topics: (Hex | Hex[] | null)[], from: bigint, to: bigint): Promise<Log[]> {
  try {
    return await rawLogs(net, address, topics, from, to);
  } catch (e) {
    if (to <= from) throw e;
    const mid = from + (to - from) / 2n;
    const [a, b] = await Promise.all([rangedLogs(net, address, topics, from, mid), rangedLogs(net, address, topics, mid + 1n, to)]);
    return [...a, ...b];
  }
}

const normalize = (l: Log) => ({ ...l, blockNumber: BigInt(l.blockNumber!), logIndex: Number(l.logIndex) }) as Log;

export async function timeline(who: Address): Promise<ChainEvent[]> {
  const all = await Promise.all(
    NETS_READY.map(async (net) => {
      const head = await net.client.getBlockNumber();
      const logs = await rangedLogs(net, [net.dep!.registry], [ACCOUNT_EVENTS, pad(who)], BigInt(net.dep!.startBlock ?? 0), head);
      return logs.map((l) => decode(net, normalize(l))).filter((e): e is ChainEvent => !!e);
    }),
  );
  const events = await withTimes(all.flat());
  return events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.logIndex - b.logIndex);
}

/** The newest logs in [from, to]: on an oversized response, search the newer half first and stop once `want` are found. */
async function newestLogs(net: Net, address: Address[], from: bigint, to: bigint, want: number, topics: (Hex | Hex[] | null)[] = []): Promise<Log[]> {
  try {
    return await rawLogs(net, address, topics, from, to);
  } catch (e) {
    if (to <= from) throw e;
    const mid = from + (to - from) / 2n;
    const newer = await newestLogs(net, address, mid + 1n, to, want, topics);
    if (newer.length >= want) return newer;
    return [...(await newestLogs(net, address, from, mid, want - newer.length, topics)), ...newer];
  }
}

/** Incremental tail of registry + guard events for one chain. The first call walks back until it finds recent history. */
export function createTail(net: Net, want = 12, maxWindows = 14) {
  let next: bigint | null = null;
  const addrs = () => [net.dep!.registry, net.dep!.guard];
  const decodeAll = (logs: Log[]) =>
    // Bulk imports emit thousands of events per block; the feed only ever shows the newest few.
    withTimes(logs.slice(-150).map((l) => decode(net, normalize(l))).filter((e): e is ChainEvent => !!e));

  return async (): Promise<ChainEvent[]> => {
    const head = await net.client.getBlockNumber();
    if (next === null) {
      const start = BigInt(net.dep!.startBlock ?? 0);
      let found: Log[] = [];
      let to = head;
      // Newest first with a growing window: quiet chains find history fast, busy blocks stay small.
      for (let i = 0, window = 50n; i < maxWindows && to >= start && found.length < want; i++, window *= 2n) {
        const from = to - window + 1n > start ? to - window + 1n : start;
        found = [...(await newestLogs(net, addrs(), from, to, want - found.length)), ...found];
        to = from - 1n;
      }
      next = head + 1n;
      return decodeAll(found);
    }
    if (next > head) return [];
    const logs = await rangedLogs(net, addrs(), [], next, head);
    next = head + 1n;
    return decodeAll(logs);
  };
}

const MIRRORED = toEventSelector(registryAbi.find((x) => x.type === "event" && x.name === "FlagMirrored") as AbiEvent);

/** Time of the newest flag the relayer wrote into this chain (works without access to the relayer itself). */
export async function lastMirrorAt(net: Net): Promise<number | null> {
  const head = await net.client.getBlockNumber();
  const start = BigInt(net.dep!.startBlock ?? 0);
  let to = head;
  for (let window = 200n; to >= start && window <= 3_276_800n; window *= 4n) {
    const from = to - window + 1n > start ? to - window + 1n : start;
    const logs = await newestLogs(net, [net.dep!.registry], from, to, 1, [MIRRORED]);
    if (logs.length) return blockTime(net, BigInt(logs[logs.length - 1].blockNumber!));
    to = from - 1n;
  }
  return null;
}

// ---------------------------------------------------------------- registry state

export interface ChainStats {
  net: Net;
  head: bigint;
  totalFlags: bigint;
  activeFlags: bigint;
  uniqueReporters: bigint;
  totalStaked: bigint;
  rewardPool: bigint;
  mirroredFlags: bigint;
  minStake: bigint;
  threshold: number;
  committee: readonly Address[];
}

export async function chainStats(net: Net): Promise<ChainStats> {
  const reg = { address: net.dep!.registry, abi: registryAbi } as const;
  const [head, s, minStake, threshold, committee] = await Promise.all([
    net.client.getBlockNumber(),
    net.client.readContract({ ...reg, functionName: "stats" }),
    net.client.readContract({ ...reg, functionName: "minStake" }),
    net.client.readContract({ ...reg, functionName: "threshold" }),
    net.client.readContract({ ...reg, functionName: "getCommittee" }),
  ]);
  const [totalFlags, activeFlags, uniqueReporters, totalStaked, rewardPool, mirroredFlags] = s;
  return { net, head, totalFlags, activeFlags, uniqueReporters, totalStaked, rewardPool, mirroredFlags, minStake, threshold, committee };
}

export interface RegistryEntry {
  net: Net;
  account: Address;
  flag: Flag;
}

export async function registryEntries(net: Net): Promise<RegistryEntry[]> {
  const reg = { address: net.dep!.registry, abi: registryAbi } as const;
  const count = await net.client.readContract({ ...reg, functionName: "flaggedCount" });
  const out: RegistryEntry[] = [];
  const pages = [];
  for (let off = 0n; off < count; off += 1000n) pages.push(net.client.readContract({ ...reg, functionName: "getFlags", args: [off, 1000n] }));
  for (const [accounts, flags] of await Promise.all(pages)) accounts.forEach((account, i) => out.push({ net, account, flag: flags[i] as Flag }));
  return out;
}

// ---------------------------------------------------------------- formatting

export const short = (a: string, n = 4) => (a.length > 2 + 2 * n ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a);
export const eth = (wei: bigint, dp = 4) => {
  const v = Number(formatEther(wei));
  return v === 0 ? "0" : v < 10 ** -dp ? `<${10 ** -dp}` : v.toLocaleString(undefined, { maximumFractionDigits: dp });
};
export function ago(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const txUrl = (net: Net, hash: string) => (net.explorer ? `${net.explorer}/tx/${hash}` : null);
export const addrUrl = (net: Net, a: string) => (net.explorer ? `${net.explorer}/address/${a}` : null);
export const chainName = (id: bigint | number) => netById(Number(id))?.name ?? `chain ${id}`;

export const SEVERITY_LABEL = ["—", "SOFT WARNING", "ELEVATED", "HARD BLOCK"] as const;

/** Human-readable reason for a failed call, decoding ChainGuard custom errors. */
export function explainError(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data) {
      const a = (rev.data.args ?? []) as unknown[];
      switch (rev.data.errorName) {
        case "AddressBlocked":
          return `Transfer blocked by ComplianceGuard: ${short(String(a[0]), 6)} is flagged ${CATEGORIES[Number(a[1])]} (severity ${a[2]})`;
        case "InsufficientStake":
          return `Stake too low — minimum is ${eth(a[0] as bigint)} ETH`;
        case "FlagActive":
          return "This address already has an active flag";
        case "NoPendingFlag":
          return "No pending flag to vote on";
        case "NoConfirmedFlag":
          return "No confirmed flag on this address";
        case "NotCommittee":
          return "Only committee members can vote";
        case "AlreadyVoted":
          return "You already voted on this flag";
        case "ForeignFlag":
          return `This flag is governed on ${chainName(a[0] as bigint)} — vote there`;
        case "NotExpired":
          return "Flag has not expired yet";
        case "NothingToWithdraw":
          return "Nothing to withdraw";
        default:
          return `${rev.data.errorName}(${a.map(String).join(", ")})`;
      }
    }
    if (rev?.reason) return rev.reason;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
