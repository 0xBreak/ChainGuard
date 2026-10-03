import { useEffect, useState } from "react";
import { formatEther, keccak256, parseEther, toBytes, type Address } from "viem";
import { registryAbi } from "../../../shared/abis";
import type { ChainKey } from "../../../shared/chains";
import { NETS } from "../config";
import { CATEGORIES, NETS_READY, eth, toAddr } from "../lib/chainguard";
import { useWallet } from "../lib/wallet";
import { useStats } from "../hooks/data";
import { ChainTag, Panel, useToast, useTx } from "./ui";
import type { ReportDraft } from "./RiskChecker";

const CATEGORY_HELP: Record<string, string> = {
  SANCTIONED: "OFAC / UN / EU sanctions list match",
  PHISHING: "drainer, fake site, permit phishing",
  RUGPULL: "LP drain, mint exploit, exit scam",
  MIXER: "mixer deposit / withdrawal cluster",
  SCAM_REPORTED: "victim report with tx evidence",
  EXPLOIT: "protocol hack / bridge exploit proceeds",
};
const SEV = ["", "Soft warning", "Elevated", "Hard block"];

export function SubmitFlag({ prefill, draft, onFlagged }: { prefill: Address | null; draft: ReportDraft | null; onFlagged: (a: Address) => void }) {
  const wallet = useWallet();
  const toast = useToast();
  const { run, busy } = useTx();
  const stats = useStats();

  const [chain, setChain] = useState<ChainKey>(NETS_READY[0]?.key ?? "arbitrum");
  const [target, setTarget] = useState("");
  const [category, setCategory] = useState(2);
  const [severity, setSeverity] = useState(3);
  const [evidence, setEvidence] = useState("");
  const [stake, setStake] = useState("");

  const s = stats.data?.find((x) => x.net.key === chain);
  const minStake = s?.minStake ?? 0n;
  const isMember = !!wallet.address && !!s?.committee.some((m) => m.toLowerCase() === wallet.address!.toLowerCase());
  const threshold = s?.threshold ?? 2;
  const committeeSize = s?.committee.length ?? 3;

  useEffect(() => {
    if (prefill) setTarget(prefill);
  }, [prefill]);
  useEffect(() => {
    if (!draft) return;
    setTarget(draft.address);
    if (draft.category) setCategory(draft.category);
    if (draft.severity) setSeverity(draft.severity);
    setEvidence(draft.evidence);
  }, [draft]);
  useEffect(() => {
    if (minStake && !stake) setStake(formatEther(minStake));
  }, [minStake, stake]);

  let value = 0n;
  try {
    value = stake ? parseEther(stake) : 0n;
  } catch {
    value = -1n;
  }
  const targetAddr = toAddr(target);
  const targetOk = targetAddr !== null;
  const stakeOk = isMember || (value >= minStake && value > 0n);
  const canSubmit = targetOk && stakeOk && evidence.trim().length > 0 && !busy;

  const submit = async () => {
    if (!wallet.address) {
      try {
        await wallet.connectInjected();
      } catch (e) {
        toast({ kind: "bad", body: (e as Error).message });
      }
      return;
    }
    const net = NETS[chain];
    const who = targetAddr!;
    const uri = evidence.trim();
    const res = await run("Flag submitted", net.chainId, (w) =>
      w.writeContract({
        address: net.dep!.registry,
        abi: registryAbi,
        functionName: "flagAddress",
        args: [who, category, severity, keccak256(toBytes(uri)), uri],
        value: value > 0n ? value : 0n,
      }),
    );
    if (res.ok) onFlagged(who);
  };

  return (
    <Panel
      idx="04"
      id="report"
      title="Report an address"
      right={<span className="muted">staked reporting</span>}
      hint={
        draft
          ? "Prefilled from threat intelligence. Review the details and submit. Committee members don't need to stake, and their report counts as the first vote."
          : "Seen a scammer, drainer or exploit wallet? Put up a small stake and report it. Honest reports get the stake back plus 20%. False ones lose it."
      }
    >
      <div className="pb form">
        <div className="flow" aria-label="How staking works">
          <div className="step">
            <b>1 · Stake</b>
            <span className="muted">
              Lock ≥ {minStake ? eth(minStake) : "…"} ETH. Flag goes live as a <span className="amber">soft warning</span> only.
            </span>
          </div>
          <span className="arrow">→</span>
          <div className="step">
            <b>2 · Committee</b>
            <span className="muted">
              {threshold}-of-{committeeSize} multisig reviews evidence. Quorum unlocks full severity.
            </span>
          </div>
          <span className="arrow">→</span>
          <div className="outcomes">
            <div className="outcome ok">
              ✓ Confirmed
              <small>stake back + 20% reward</small>
            </div>
            <div className="outcome bad">
              ✕ False flag
              <small>50% to victim · 50% to pool</small>
            </div>
          </div>
        </div>

        <div className="field">
          <span>Network</span>
          <div className="seg">
            {NETS_READY.map((n) => (
              <button key={n.key} type="button" className={chain === n.key ? "on" : ""} onClick={() => setChain(n.key)}>
                <ChainTag k={n.key} /> {n.name}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Suspicious address</span>
          <input
            className={`input ${target && !targetOk ? "bad" : ""}`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>

        <div className="row-2">
          <label className="field">
            <span>Category</span>
            <select className="select" value={category} onChange={(e) => setCategory(Number(e.target.value))}>
              {CATEGORIES.slice(1).map((c, i) => (
                <option key={c} value={i + 1}>
                  {c} — {CATEGORY_HELP[c]}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Severity</span>
            <div className="seg">
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" className={`${severity === n ? "on" : ""} s${n}`} onClick={() => setSeverity(n)} title={SEV[n]}>
                  {n} · {SEV[n].split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="field">
          <span>Evidence (tx hash, report URL, IPFS CID)</span>
          <input className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://… or ipfs://…" />
        </label>

        <div className="row-2" style={{ alignItems: "end" }}>
          <label className="field">
            <span>Stake (ETH){isMember && " — optional for committee"}</span>
            <input className={`input ${!stakeOk && stake ? "bad" : ""}`} value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />
          </label>
          <button className="btn primary" disabled={!!wallet.address && !canSubmit} onClick={submit} style={{ height: 41 }}>
            {busy
              ? "Submitting…"
              : !wallet.address
                ? "Connect wallet & stake"
                : isMember
                  ? "Flag as committee"
                  : `Stake ${stake || "0"} ETH & flag`}
          </button>
        </div>
        {isMember && (
          <div className="result info">
            You are on the {s?.net.name} committee — your flag counts as the first confirm vote.
          </div>
        )}
      </div>
    </Panel>
  );
}
