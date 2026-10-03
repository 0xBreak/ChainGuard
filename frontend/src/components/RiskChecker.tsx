import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { registryAbi } from "../../../shared/abis";
import { netById } from "../config";
import {
  CATEGORIES,
  SEVERITY_LABEL,
  STATUSES,
  ago,
  chainName,
  checkAddress,
  eth,
  isActiveStatus,
  short,
  timeline,
  toAddr,
  txUrl,
  type CheckResult,
} from "../lib/chainguard";
import { describe } from "../lib/events";
import { DEMO_TARGETS, lookupThreat, type IntelResult } from "../lib/intel";
import { useWallet } from "../lib/wallet";
import { useNow, useStats } from "../hooks/data";
import { Addr, ChainTag, Panel, Sev, useTx } from "./ui";

export interface ReportDraft {
  address: Address;
  category: number;
  severity: number;
  evidence: string;
}

export function SearchHero({ target, onCheck }: { target: Address | null; onCheck: (a: Address) => void }) {
  const [value, setValue] = useState(target ?? "");
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (target) setValue(target);
  }, [target]);

  const submit = (v = value) => {
    const a = toAddr(v);
    if (!a) return setErr(true);
    setErr(false);
    onCheck(a);
  };

  return (
    <div className="hero">
      <div className="eyebrow">Compliance firewall for stablecoins &amp; tokenized stocks</div>
      <h1>
        Is this address <span className="red">safe</span> to transact with?
      </h1>
      <p>
        Paste any EVM address. ChainGuard checks it against its <b>on-chain registry</b> (what tokens actually enforce) and{" "}
        <b>10,000+ known threats</b> from OFAC, exploit trackers, ScamSniffer, Etherscan and GoPlus.
      </p>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="prompt">&gt;_</span>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setErr(false);
          }}
          placeholder="0x… paste a wallet or contract address"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={err}
          style={err ? { color: "var(--red)" } : undefined}
        />
        <button className="btn primary" type="submit">
          Check
        </button>
      </form>
      <div className="samples">
        {err ? (
          <span className="red">That isn't a valid EVM address (0x + 40 hex characters).</span>
        ) : (
          <>
            <span>Not sure what to try? Click one:</span>
            {DEMO_TARGETS.map((s) => (
              <button key={s.address} type="button" className={`chip ${s.tag}`} onClick={() => onCheck(s.address)} title={s.address}>
                {s.label}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

type Verdict = "BLOCKED" | "WARNING" | "KNOWN" | "CLEAN";

function verdictOf(r: CheckResult, intel: IntelResult | undefined): Verdict {
  if (r.verdict === "BLOCKED") return "BLOCKED";
  if (r.verdict === "WARNING") return "WARNING";
  if (intel && intel.severity > 0) return "KNOWN";
  return "CLEAN";
}

const VERDICT_COPY: Record<Verdict, { big: string; sub: string; cls: string; explain: string }> = {
  BLOCKED: {
    big: "BLOCKED",
    sub: "transfers revert",
    cls: "blocked",
    explain: "Guarded tokens (USDG, TSLA) reject every transfer to or from this address, on both chains.",
  },
  WARNING: {
    big: "WARNING",
    sub: "allowed · monitored",
    cls: "warn",
    explain: "Transfers still go through, but each one emits an on-chain ComplianceWarning. This is a soft flag: low severity, or a report the committee hasn't confirmed yet.",
  },
  KNOWN: {
    big: "KNOWN THREAT",
    sub: "not enforced yet",
    cls: "known",
    explain: "Public threat feeds list this address, but the on-chain registry doesn't have it yet, so tokens can't block it. Report it below to get it enforced.",
  },
  CLEAN: {
    big: "CLEAN",
    sub: "no flags found",
    cls: "clean",
    explain: "Not in the on-chain registry on either chain and not in any threat feed we track. Transfers are allowed.",
  },
};

export function RiskResult({ target, onReport, onTest }: { target: Address | null; onReport: (d: ReportDraft) => void; onTest: () => void }) {
  const now = useNow();
  const wallet = useWallet();
  const stats = useStats();
  const { run, busy } = useTx();
  const check = useQuery({ queryKey: ["check", target], queryFn: () => checkAddress(target!), enabled: !!target, refetchInterval: 4000 });
  const intel = useQuery({ queryKey: ["intel", target], queryFn: () => lookupThreat(target!), enabled: !!target, staleTime: 60_000 });
  const tl = useQuery({ queryKey: ["timeline", target], queryFn: () => timeline(target!), enabled: !!target });

  if (!target) {
    return (
      <Panel idx="01" title="Risk verdict" hint="The result of a check shows up here.">
        <div className="empty">
          <p style={{ margin: "0 0 10px" }}>Start by checking an address. Use the box above, click one of the examples, or click any row in the live feed.</p>
          <span className="dim">Everything is read straight from the blockchain and public threat feeds. There is no backend.</span>
        </div>
      </Panel>
    );
  }

  const r = check.data;
  const v = r ? verdictOf(r, intel.data) : null;
  const copy = v ? VERDICT_COPY[v] : null;
  const p = r?.primary;
  const flag = p?.flag;
  const govNet = flag ? netById(Number(flag.sourceChainId)) : undefined;
  const govStats = stats.data?.find((s) => s.net.chainId === govNet?.chainId);
  const isMember = !!wallet.address && !!govStats?.committee.some((m) => m.toLowerCase() === wallet.address!.toLowerCase());
  const flaggedEvent = tl.data?.filter((e) => e.name === "AddressFlagged").at(-1);
  const evidenceURI = flaggedEvent ? String((flaggedEvent.args as { evidenceURI?: string }).evidenceURI ?? "") : "";
  const category = r && r.severity ? r.category : (intel.data?.category ?? 0);

  // Who put the flag on-chain vs where the threat information comes from. Committee imports carry no stake;
  // the reporter field is then just the committee member who submitted the public-feed entry.
  const stakeAtFlag = flaggedEvent ? ((flaggedEvent.args as { stake?: bigint }).stake ?? 0n) : 0n;
  const memberIdx = flag ? (govStats?.committee.findIndex((m) => m.toLowerCase() === flag.reporter.toLowerCase()) ?? -1) : -1;
  const feedImport = memberIdx >= 0 && stakeAtFlag === 0n;
  const evidenceLabel = evidenceURI.includes(" | ") ? evidenceURI.split(" | ")[0] : "";
  const source = feedImport
    ? `Public feed: ${intel.data?.feeds[0]?.source.name || evidenceLabel || "committee decision"}`
    : "User report (evidence below)";
  const submitter =
    memberIdx >= 0
      ? `Committee member #${memberIdx + 1} · ${feedImport ? "feed import" : `staked ${eth(stakeAtFlag)} ETH`}`
      : `Independent reporter · staked ${eth(stakeAtFlag)} ETH`;

  const vote = (fn: "confirmFlag" | "rejectFlag" | "unflagAddress", label: string) =>
    govNet && run(label, govNet.chainId, (w) => w.writeContract({ address: govNet.dep!.registry, abi: registryAbi, functionName: fn, args: [target] }));

  return (
    <Panel
      idx="01"
      title="Risk verdict"
      right={
        <span className="mono" style={{ textTransform: "none", letterSpacing: 0 }}>
          {target}
        </span>
      }
    >
      {(check.isLoading || intel.isLoading) && <div className="scan" />}
      {check.error && <div className="empty red">RPC error: {(check.error as Error).message.slice(0, 160)}</div>}
      {r && copy && v && (
        <>
          <div className="verdict">
            <div className={`badge ${copy.cls}`} key={`${target}-${v}`}>
              <div className="big">{copy.big}</div>
              <div className="sub">{copy.sub}</div>
            </div>
            <div>
              <p className="explain">{copy.explain}</p>
              <div className="kv">
                <div>
                  <span>Category</span>
                  <b className={v === "CLEAN" ? "green" : v === "BLOCKED" ? "red" : "amber"}>{category ? CATEGORIES[category] : "NONE"}</b>
                </div>
                <div>
                  <span>Enforced on-chain</span>
                  <b>
                    <Sev n={r.severity} /> <span className="muted">{r.severity ? SEVERITY_LABEL[r.severity] : "nothing"}</span>
                  </b>
                </div>
                {flag && (
                  <>
                    <div>
                      <span>Registry status</span>
                      <b>
                        {STATUSES[flag.status]}
                        {flag.status === 1 && <span className="muted"> · sev {flag.severity} after quorum</span>}
                      </b>
                    </div>
                    <div>
                      <span>Reported on</span>
                      <b>{chainName(flag.sourceChainId)}</b>
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <span>Source</span>
                      <b>{source}</b>
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <span>Submitted on-chain by</span>
                      <b>
                        {submitter} <span className="muted">(<Addr a={flag.reporter} net={govNet} />)</span>
                      </b>
                    </div>
                    <div>
                      <span>Flagged</span>
                      <b>{ago(Number(flag.timestamp) * 1000, now)}</b>
                    </div>
                  </>
                )}
              </div>
              {evidenceURI && <Evidence text={evidenceURI} />}
            </div>
          </div>

          <div className="actions">
            {v === "KNOWN" && intel.data && (
              <button
                className="btn primary"
                onClick={() =>
                  onReport({ address: target, category: intel.data!.category, severity: intel.data!.severity, evidence: intel.data!.evidence ?? "" })
                }
              >
                Report to registry →
              </button>
            )}
            {v !== "CLEAN" && (
              <button className="btn" onClick={onTest}>
                Test a USDG transfer to it →
              </button>
            )}
            {flag && isMember && flag.status === 1 && (
              <>
                <button className="btn bad" disabled={!!busy} onClick={() => vote("confirmFlag", "Confirm vote")}>
                  Committee: confirm
                </button>
                <button className="btn ok" disabled={!!busy} onClick={() => vote("rejectFlag", "Reject vote")}>
                  Committee: reject
                </button>
              </>
            )}
            {flag && isMember && flag.status === 2 && (
              <button className="btn ok" disabled={!!busy} onClick={() => vote("unflagAddress", "Lift vote")}>
                Committee: vote to lift flag ({flag.clearVotes}/{govStats?.threshold})
              </button>
            )}
          </div>

          <div className="chains">
            {r.chains.map((c) => {
              const f = c.flag;
              const active = f && isActiveStatus(f.status);
              const origin = f && Number(f.sourceChainId) === c.net.chainId;
              return (
                <div key={c.net.key}>
                  <ChainTag k={c.net.key} />
                  <span style={{ flex: 1 }}>{c.net.name}</span>
                  {active ? (
                    <span className={`pill ${c.severity >= 3 ? "red" : "amber"}`}>
                      {c.severity >= 3 ? "blocked" : "warning"} · {origin ? "reported here" : "synced"}
                    </span>
                  ) : (
                    <span className="pill green">not flagged</span>
                  )}
                </div>
              );
            })}
          </div>

          <IntelBlock intel={intel.data} loading={intel.isLoading} />

          <div className="ph" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <h2>On-chain history</h2>
            <span className="grow" />
            {tl.isFetching && <span className="dim">scanning logs…</span>}
          </div>
          {tl.data && tl.data.length === 0 && <div className="empty">This address has never appeared in the registry on either chain.</div>}
          {tl.error && <div className="empty red">Could not load logs: {(tl.error as Error).message.slice(0, 120)}</div>}
          {tl.data && tl.data.length > 0 && (
            <ul className="timeline">
              {tl.data.map((e) => {
                const d = describe(e);
                const url = txUrl(e.net, e.txHash);
                return (
                  <li key={e.id} className={d.tone}>
                    <div className="tl-head">
                      <ChainTag k={e.net.key} />
                      <b className={d.tone === "muted" ? "muted" : d.tone}>{d.label}</b>
                      <span className="dim">
                        {e.time ? new Date(e.time).toLocaleString() : `block ${e.blockNumber}`} · {ago(e.time, now)}
                      </span>
                    </div>
                    <div className="tl-body">
                      {d.detail}
                      {" · "}
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          tx {short(e.txHash, 5)}
                        </a>
                      ) : (
                        <span>tx {short(e.txHash, 5)}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

/** Evidence strings are "label | url"; render the URL as a link. */
export function Evidence({ text }: { text: string }) {
  const isUrl = /^\w+:\/\//.test(text);
  const [label, url] = text.includes(" | ") ? text.split(" | ") : isUrl ? ["", text] : [text, ""];
  return (
    <div className="evidence">
      <span>Evidence</span>
      {label && <b>{label}</b>}
      {url &&
        (/^https?:/.test(url) ? (
          <a href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        ) : (
          <code>{url}</code>
        ))}
    </div>
  );
}

function IntelBlock({ intel, loading }: { intel: IntelResult | undefined; loading: boolean }) {
  return (
    <div className="intel">
      <div className="intel-head">
        <h3>Threat intelligence</h3>
        <span className="dim">public feeds + GoPlus live · for information only, tokens enforce the registry</span>
      </div>
      {loading && <div className="dim">querying feeds…</div>}
      {intel && intel.feeds.length === 0 && intel.live.length === 0 && (
        <div className="intel-row clean">
          <span className="dot green" /> No hits in OFAC, exploit trackers, ScamSniffer, Etherscan, MEW or GoPlus.
          {intel.liveError && <span className="dim"> (GoPlus unreachable)</span>}
        </div>
      )}
      {intel?.feeds.map((f, i) => (
        <div className="intel-row" key={`f${i}`}>
          <span className={`cat c${f.category}`}>{CATEGORIES[f.category]}</span>
          <b>{f.label}</b>
          <a className="dim" href={f.url} target="_blank" rel="noreferrer" title={f.url}>
            {f.source.name} ↗
          </a>
        </div>
      ))}
      {intel?.live.map((h) => (
        <div className="intel-row" key={h.key}>
          <span className="cat live">LIVE</span>
          <b>{h.label}</b>
          <span className="dim">GoPlus · reported by {h.source || "GoPlus"}</span>
        </div>
      ))}
    </div>
  );
}
