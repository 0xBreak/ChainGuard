// Off-chain threat intelligence: GoPlus address security (aggregates SlowMist, BlockSec, …) and the OFAC SDN list.
// Used by the importer (to put known threats into the on-chain registry) and by the UI (to warn about
// addresses that are known-bad but not yet enforced on-chain).

export const OFAC_ETH_LIST =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";
const GOPLUS = "https://api.gopluslabs.io/api/v1/address_security";
const GOPLUS_CHAINS = [1, 42161]; // Ethereum, Arbitrum One — where real exploit history lives

/** Category indexes match IComplianceRegistry.Category. */
export const CAT = { SANCTIONED: 1, PHISHING: 2, RUGPULL: 3, MIXER: 4, SCAM_REPORTED: 5, EXPLOIT: 6 } as const;

const SIGNALS: Record<string, { label: string; category: number; severity: number }> = {
  sanctioned: { label: "Sanctioned", category: CAT.SANCTIONED, severity: 3 },
  stealing_attack: { label: "Theft / exploit", category: CAT.EXPLOIT, severity: 3 },
  cybercrime: { label: "Cybercrime", category: CAT.EXPLOIT, severity: 3 },
  financial_crime: { label: "Financial crime", category: CAT.EXPLOIT, severity: 3 },
  blackmail_activities: { label: "Blackmail", category: CAT.EXPLOIT, severity: 3 },
  phishing_activities: { label: "Phishing", category: CAT.PHISHING, severity: 3 },
  fake_kyc: { label: "Fake KYC", category: CAT.PHISHING, severity: 2 },
  darkweb_transactions: { label: "Darkweb transactions", category: CAT.SCAM_REPORTED, severity: 3 },
  money_laundering: { label: "Money laundering", category: CAT.MIXER, severity: 3 },
  mixer: { label: "Mixer", category: CAT.MIXER, severity: 2 },
  honeypot_related_address: { label: "Honeypot related", category: CAT.RUGPULL, severity: 2 },
  number_of_malicious_contracts_created: { label: "Created malicious contracts", category: CAT.RUGPULL, severity: 3 },
  fake_token: { label: "Fake token", category: CAT.RUGPULL, severity: 2 },
  fake_standard_interface: { label: "Fake standard interface", category: CAT.RUGPULL, severity: 2 },
  malicious_mining_activities: { label: "Malicious mining", category: CAT.SCAM_REPORTED, severity: 2 },
  gas_abuse: { label: "Gas abuse", category: CAT.SCAM_REPORTED, severity: 1 },
  reinit: { label: "Reinit attack", category: CAT.EXPLOIT, severity: 2 },
  blacklist_doubt: { label: "Suspected blacklist", category: CAT.SCAM_REPORTED, severity: 2 },
};

/** Curated incidents, re-verified against GoPlus on import. */
export const KNOWN_EXPLOITERS: { address: `0x${string}`; label: string; evidence: string }[] = [
  {
    address: "0x5d3919F12bCc35c26Eee5F8226A9bee90c257Ccc",
    label: "Kelp DAO rsETH bridge exploiter (Apr 2026, ~$292M)",
    evidence: "https://rekt.news/kelpdao-rekt",
  },
  {
    address: "0x47666Fab8bd0Ac7003bce3f5C3585383F09486E2",
    label: "Bybit exploiter 1 (Feb 2025, ~$1.4B)",
    evidence: "https://etherscan.io/address/0x47666fab8bd0ac7003bce3f5c3585383f09486e2",
  },
];

/** Tornado Cash ETH pools, verified on-chain via denomination() + shared verifier (Ethereum) and denomination() (Arbitrum One). */
export const MIXERS: { address: `0x${string}`; label: string }[] = [
  { address: "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b", label: "Tornado Cash: Router (Ethereum)" },
  { address: "0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc", label: "Tornado Cash: 0.1 ETH pool (Ethereum)" },
  { address: "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936", label: "Tornado Cash: 1 ETH pool (Ethereum)" },
  { address: "0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF", label: "Tornado Cash: 10 ETH pool (Ethereum)" },
  { address: "0xA160cdAB225685dA1d56aa342Ad8841c3b53f291", label: "Tornado Cash: 100 ETH pool (Ethereum)" },
  { address: "0x84443CFd09A48AF6eF360C6976C5392aC5023a1F", label: "Tornado Cash: 0.1 ETH pool (Arbitrum)" }, // explorer: arbiscan
  { address: "0xd47438C816c9E7f2E2888E060936a499Af9582b3", label: "Tornado Cash: 1 ETH pool (Arbitrum)" },
  { address: "0x330bdFADE01eE9bF63C209Ee33102DD334618e0a", label: "Tornado Cash: 10 ETH pool (Arbitrum)" },
  { address: "0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD", label: "Tornado Cash: 100 ETH pool (Arbitrum)" },
];

// ---------------------------------------------------------------- compiled threat database

export interface ThreatSource {
  id: string;
  name: string;
  url: string;
  count: number;
}

/** [sourceIndex, category, severity, label, evidence url?] */
export type ThreatRecord = [number, number, number, string, string?];

export interface ThreatDb {
  generatedAt: string;
  sources: ThreatSource[];
  /** lowercase address -> records from every source that lists it, strongest first */
  entries: Record<string, ThreatRecord[]>;
}

export interface IntelHit {
  key: string;
  label: string;
  source: string;
}

export interface IntelReport {
  address: string;
  hits: IntelHit[];
  category: number; // 0 when clean
  severity: number;
  sources: string[];
  evidence: string | null;
  errors: string[];
}

let ofacCache: Promise<Set<string>> | null = null;
export function ofacList(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  ofacCache ??= fetchImpl(OFAC_ETH_LIST)
    .then((r) => {
      if (!r.ok) throw new Error(`OFAC list HTTP ${r.status}`);
      return r.text();
    })
    .then((t) => new Set(t.split(/\s+/).filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l)).map((l) => l.toLowerCase())))
    .catch((e) => {
      ofacCache = null;
      throw e;
    });
  return ofacCache;
}

async function goplus(address: string, chainId: number, fetchImpl: typeof fetch) {
  const r = await fetchImpl(`${GOPLUS}/${address}?chain_id=${chainId}`);
  const j = (await r.json()) as { code: number; message: string; result?: Record<string, string> };
  if (j.code !== 1 || !j.result) throw new Error(`GoPlus: ${j.message}`);
  return j.result;
}

/** Live GoPlus lookup (aggregates SlowMist, BlockSec, ScamSniffer, …) on Ethereum + Arbitrum One. */
export async function goplusLookup(address: string, fetchImpl: typeof fetch = fetch): Promise<{ hits: IntelHit[]; errors: string[] }> {
  const hits = new Map<string, IntelHit>();
  const errors: string[] = [];
  const res = await Promise.allSettled(GOPLUS_CHAINS.map((c) => goplus(address, c, fetchImpl)));
  for (const r of res) {
    if (r.status === "rejected") {
      errors.push(String(r.reason));
      continue;
    }
    const src = r.value.data_source || "GoPlus";
    for (const [key, v] of Object.entries(r.value)) {
      if (!SIGNALS[key] || v === "0" || v === "" || hits.has(key)) continue;
      hits.set(key, { key, label: SIGNALS[key].label, source: src });
    }
  }
  return { hits: [...hits.values()], errors };
}

export const signalOf = (key: string) => SIGNALS[key];

export async function lookupIntel(address: string, fetchImpl: typeof fetch = fetch): Promise<IntelReport> {
  const hits = new Map<string, IntelHit>();
  const sources = new Set<string>();
  const errors: string[] = [];

  const [ofac, ...gp] = await Promise.allSettled([ofacList(fetchImpl), ...GOPLUS_CHAINS.map((c) => goplus(address, c, fetchImpl))]);

  if (ofac.status === "fulfilled") {
    if (ofac.value.has(address.toLowerCase())) {
      hits.set("ofac", { key: "sanctioned", label: "OFAC SDN list", source: "US Treasury OFAC" });
      sources.add("OFAC");
    }
  } else errors.push(String(ofac.reason));

  for (const res of gp) {
    if (res.status === "rejected") {
      errors.push(String(res.reason));
      continue;
    }
    const src = res.value.data_source || "GoPlus";
    for (const [key, v] of Object.entries(res.value)) {
      if (!SIGNALS[key] || v === "0" || v === "" || hits.has(key)) continue;
      hits.set(key, { key, label: SIGNALS[key].label, source: src });
      src.split(",").forEach((s) => sources.add(s.trim()));
    }
  }

  // Strongest signal wins: highest severity, then sanctions over everything else.
  let category = 0;
  let severity = 0;
  for (const h of hits.values()) {
    const s = SIGNALS[h.key];
    if (s.severity > severity || (s.severity === severity && s.category === CAT.SANCTIONED)) {
      category = s.category;
      severity = s.severity;
    }
  }
  const curated = KNOWN_EXPLOITERS.find((k) => k.address.toLowerCase() === address.toLowerCase());
  const evidence = curated?.evidence ?? (hits.size ? `https://etherscan.io/address/${address}` : null);
  return { address, hits: [...hits.values()], category, severity, sources: [...sources], evidence, errors };
}
