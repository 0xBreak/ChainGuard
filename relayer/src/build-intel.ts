// Download public threat feeds and compile shared/intel/threat-db.json (used by the UI and the importer).
// Run: cd relayer && bun src/build-intel.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAT, KNOWN_EXPLOITERS, MIXERS, OFAC_ETH_LIST, type ThreatDb, type ThreatRecord, type ThreatSource } from "../../shared/intel";

const FEEDS = {
  phishing: "https://raw.githubusercontent.com/forta-network/labelled-datasets/main/labels/1/phishing_scams.csv",
  contracts: "https://raw.githubusercontent.com/forta-network/labelled-datasets/main/labels/1/malicious_smart_contracts.csv",
  etherscan: "https://raw.githubusercontent.com/forta-network/labelled-datasets/main/labels/1/etherscan_malicious_labels.csv",
  scamsniffer: "https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json",
  mew: "https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json",
};

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const sources: ThreatSource[] = [];
const entries: Record<string, ThreatRecord[]> = {};

function add(src: number, address: string, category: number, severity: number, label: string, url?: string) {
  if (!isAddr(address)) return;
  const k = address.toLowerCase();
  const list = (entries[k] ??= []);
  if (list.some((r) => r[0] === src)) return;
  list.push(url ? [src, category, severity, label.slice(0, 96), url] : [src, category, severity, label.slice(0, 96)]);
  sources[src].count++;
}
function source(id: string, name: string, url: string) {
  sources.push({ id, name, url, count: 0 });
  return sources.length - 1;
}
/** Minimal RFC-4180 row splitter (handles quoted commas). */
function csvRows(text: string): string[][] {
  return text
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      let q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) (out.push(cur), (cur = ""));
        else cur += ch;
      }
      out.push(cur);
      return out.map((c) => c.trim());
    });
}

async function get(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// 1. OFAC SDN
const ofac = source("ofac", "US Treasury OFAC SDN list", "https://sanctionssearch.ofac.treas.gov");
for (const a of (await get(OFAC_ETH_LIST)).split(/\s+/)) add(ofac, a, CAT.SANCTIONED, 3, "OFAC SDN sanctioned address");

// 2. Exploits: curated incidents + named exploiter/hacker labels from Etherscan
const exploit = source("exploits", "Exploit & hack attributions (curated + Etherscan labels)", "https://rekt.news/leaderboard");
for (const k of KNOWN_EXPLOITERS) add(exploit, k.address, CAT.EXPLOIT, 3, k.label, k.evidence);
const etherscan = source("etherscan", "Etherscan phish/hack label cloud (via Forta labelled datasets)", FEEDS.etherscan);
const labelled = [...csvRows(await get(FEEDS.etherscan)), ...csvRows(await get(FEEDS.phishing))];
for (const [address, tag = ""] of labelled) {
  const es = `https://etherscan.io/address/${address}`;
  if (/exploit|hack|attack|heist|drain/i.test(tag)) add(exploit, address, CAT.EXPLOIT, 3, `Etherscan: ${tag}`, es);
  else if (/phish/i.test(tag)) add(etherscan, address, CAT.PHISHING, 3, "Etherscan: Fake_Phishing (phish-hack list)", es);
  else if (/scam|fake|spam/i.test(tag)) add(etherscan, address, CAT.SCAM_REPORTED, 2, `Etherscan: ${tag || "phish-hack list"}`, es);
  else add(etherscan, address, CAT.SCAM_REPORTED, 2, `Etherscan phish-hack list${tag ? `: ${tag}` : ""}`, es);
}

// Malicious contracts (exploit / heist / phishing) and the EOAs that deployed them
const contracts = source("contracts", "Malicious smart contracts & their deployers (Forta labelled datasets)", FEEDS.contracts);
for (const [contract, tag, creator, , creatorTag, , , kind] of csvRows(await get(FEEDS.contracts))) {
  const exploitish = /exploit|heist/i.test(kind);
  const cat = exploitish ? CAT.EXPLOIT : CAT.PHISHING;
  add(exploitish ? exploit : contracts, contract, cat, 3, `Malicious contract${tag ? `: ${tag}` : ` (${kind || "phish-hack"})`}`, `https://etherscan.io/address/${contract}`);
  if (creator && creatorTag) add(exploitish ? exploit : contracts, creator, cat, 3, `Deployer: ${creatorTag}`, `https://etherscan.io/address/${creator}`);
}

// 3. ScamSniffer wallet-drainer blacklist
const ss = source("scamsniffer", "ScamSniffer drainer & phishing blacklist", "https://github.com/scamsniffer/scam-database");
for (const a of JSON.parse(await get(FEEDS.scamsniffer)) as string[]) add(ss, a, CAT.PHISHING, 3, "ScamSniffer: wallet drainer / phishing");

// 4. MyEtherWallet darklist
const mew = source("mew", "MyEtherWallet darklist", "https://github.com/MyEtherWallet/ethereum-lists");
for (const e of JSON.parse(await get(FEEDS.mew)) as { address: string; comment: string }[]) {
  const phishing = /phish|fake|impersonat/i.test(e.comment);
  add(mew, e.address, phishing ? CAT.PHISHING : CAT.SCAM_REPORTED, phishing ? 3 : 2, `MEW: ${e.comment || "darklisted"}`);
}

// 5. Mixers (verified on-chain)
const mixer = source("mixers", "Mixer contracts (Tornado Cash pools, verified on-chain)", "https://etherscan.io/address/0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b");
for (const m of MIXERS) add(mixer, m.address, CAT.MIXER, 2, m.label, `https://${m.label.includes("Arbitrum") ? "arbiscan.io" : "etherscan.io"}/address/${m.address}`);

for (const list of Object.values(entries)) list.sort((a, b) => b[2] - a[2] || (a[1] === CAT.SANCTIONED ? -1 : 0));

const db: ThreatDb = { generatedAt: new Date().toISOString(), sources, entries };
const out = resolve(import.meta.dir, "../../shared/intel/threat-db.json");
writeFileSync(out, JSON.stringify(db));
console.log(`wrote ${out}: ${Object.keys(entries).length} addresses`);
for (const s of sources) console.log(`  ${s.id.padEnd(12)} ${String(s.count).padStart(6)}  ${s.name}`);
