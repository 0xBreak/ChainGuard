import { getAddress, type Address } from "viem";
import { MODE } from "../config";
import { goplusLookup, signalOf, type IntelHit, type ThreatDb, type ThreatSource } from "../../../shared/intel";

let dbPromise: Promise<ThreatDb> | null = null;
/** ~10k labelled addresses compiled from public feeds (relayer/src/build-intel.ts). Loaded lazily. */
export const loadThreatDb = () =>
  (dbPromise ??= import("../../../shared/intel/threat-db.json").then((m) => m.default as unknown as ThreatDb));

export interface FeedHit {
  source: ThreatSource;
  url: string;
  category: number;
  severity: number;
  label: string;
}

export interface IntelResult {
  feeds: FeedHit[];
  live: IntelHit[];
  liveError: string | null;
  category: number;
  severity: number;
  evidence: string | null;
}

export async function dbLookup(address: string): Promise<FeedHit[]> {
  const db = await loadThreatDb();
  return (db.entries[address.toLowerCase()] ?? []).map(([s, category, severity, label, url]) => ({ source: db.sources[s], url: url ?? db.sources[s].url, category, severity, label }));
}

export async function lookupThreat(address: Address): Promise<IntelResult> {
  const [feeds, live] = await Promise.all([
    dbLookup(address),
    goplusLookup(address).catch((e) => ({ hits: [] as IntelHit[], errors: [String(e)] })),
  ]);
  let category = 0;
  let severity = 0;
  const consider = (c: number, s: number) => {
    if (s > severity || (s === severity && c === 1)) [category, severity] = [c, s];
  };
  feeds.forEach((f) => consider(f.category, f.severity));
  live.hits.forEach((h) => {
    const sig = signalOf(h.key);
    if (sig) consider(sig.category, sig.severity);
  });
  const evidence = feeds[0] ? `${feeds[0].label} | ${feeds[0].url}` : live.hits.length ? `GoPlus/${live.hits[0].source}: ${live.hits.map((h) => h.label).join(", ")} | https://gopluslabs.io` : null;
  return { feeds, live: live.hits, liveError: live.errors.length === 2 ? live.errors[0] : null, category, severity, evidence };
}

/** Named addresses for first-time visitors. Labels come from the public sources listed in the threat DB. */
export const DEMO_TARGETS: { address: Address; label: string; tag: string }[] = (
  [
    { address: "0x5d3919F12bCc35c26Eee5F8226A9bee90c257Ccc", label: "Kelp DAO exploiter", tag: "exploit" },
    { address: "0x47666Fab8bd0Ac7003bce3f5C3585383F09486E2", label: "Bybit exploiter (not on-chain yet)", tag: "exploit" },
    { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", label: "OFAC-sanctioned", tag: "sanctions" },
    { address: "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936", label: "Tornado Cash 1 ETH", tag: "mixer" },
    { address: "0x101ce0cEDD142F199c9ef61739ae59b6611A0fC0", label: MODE === "local" ? "Drainer (pending report)" : "Wallet drainer (ScamSniffer)", tag: "phishing" },
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", label: "vitalik.eth", tag: "clean" },
  ] as const
).map((t) => ({ ...t, address: getAddress(t.address.toLowerCase()) }));
