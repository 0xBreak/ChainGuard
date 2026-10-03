import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { registryAbi } from "../../../shared/abis";
import { CATEGORIES, NETS_READY, STATUSES, ago, eth, isActiveStatus, short, type RegistryEntry } from "../lib/chainguard";
import { loadThreatDb } from "../lib/intel";
import { useWallet } from "../lib/wallet";
import { useNow, useRegistry, useSeen, useStats } from "../hooks/data";
import { ChainTag, Panel, Sev, useTx } from "./ui";

function Votes({ yes, no, threshold }: { yes: number; no: number; threshold: number }) {
  return (
    <span className="votes" title={`${yes} confirm · ${no} reject · quorum ${threshold}`}>
      {Array.from({ length: threshold }, (_, i) => (
        <i key={`y${i}`} className={i < yes ? "y" : ""} />
      ))}
      <span className="dim" style={{ margin: "0 3px" }}>
        /
      </span>
      {Array.from({ length: threshold }, (_, i) => (
        <i key={`n${i}`} className={i < no ? "n" : ""} />
      ))}
    </span>
  );
}

export function CommitteeDesk({ onPick }: { onPick: (a: Address) => void }) {
  const now = useNow();
  const wallet = useWallet();
  const [ref, seen] = useSeen<HTMLDivElement>();
  const registry = useRegistry(seen);
  const stats = useStats();
  const { run, busy } = useTx();

  // Open cases: pending reports, voted on the chain where they were raised.
  const queue = (registry.data ?? [])
    .filter((e) => Number(e.flag.sourceChainId) === e.net.chainId && e.flag.status === 1)
    .sort((a, b) => Number(b.flag.timestamp - a.flag.timestamp));

  const claimable = useQuery({
    queryKey: ["claimable", wallet.address],
    enabled: !!wallet.address,
    refetchInterval: 4000,
    queryFn: () =>
      Promise.all(
        NETS_READY.map(async (net) => ({
          net,
          amount: await net.client.readContract({ address: net.dep!.registry, abi: registryAbi, functionName: "claimable", args: [wallet.address!] }),
        })),
      ),
  });

  const memberOf = (chainId: number) => {
    const s = stats.data?.find((x) => x.net.chainId === chainId);
    return !!wallet.address && !!s?.committee.some((m) => m.toLowerCase() === wallet.address!.toLowerCase());
  };
  const thresholdOf = (chainId: number) => stats.data?.find((x) => x.net.chainId === chainId)?.threshold ?? 2;
  const act = (e: RegistryEntry, fn: "confirmFlag" | "rejectFlag", label: string) =>
    run(label, e.net.chainId, (w) => w.writeContract({ address: e.net.dep!.registry, abi: registryAbi, functionName: fn, args: [e.account] }));
  const isMemberAnywhere = NETS_READY.some((n) => memberOf(n.chainId));

  return (
    <Panel
      idx="06"
      id="governance"
      title="Committee desk — open reports"
      right={<span className={isMemberAnywhere ? "green" : "muted"}>{isMemberAnywhere ? "you are a committee member" : "read-only"}</span>}
      hint={
        <>
          Reports waiting for a decision. Until quorum ({thresholdOf(NETS_READY[0]?.chainId ?? 0)} of {stats.data?.[0]?.committee.length ?? 3}) the address only
          gets a soft warning. <b>Confirm</b> enforces the full severity and pays the reporter. <b>Reject</b> slashes the stake: half to the
          wrongly accused address, half to the reward pool. {!isMemberAnywhere && "Connect a committee wallet to vote."}
        </>
      }
    >
      <div className="table-wrap" ref={ref}>
        <table>
          <thead>
            <tr>
              <th>Chain</th>
              <th>Address</th>
              <th>Category</th>
              <th>Requested</th>
              <th>Votes ✓ / ✕</th>
              <th>Stake</th>
              <th>Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {registry.isLoading && (
              <tr>
                <td colSpan={8} className="empty">
                  loading reports…
                </td>
              </tr>
            )}
            {registry.data && queue.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  No open reports. Submit one in “Report an address” and it shows up here.
                </td>
              </tr>
            )}
            {queue.map((e) => {
              const f = e.flag;
              const member = memberOf(e.net.chainId);
              return (
                <tr key={`${e.net.key}${e.account}`}>
                  <td>
                    <ChainTag k={e.net.key} />
                  </td>
                  <td>
                    <a href="#top" onClick={() => onPick(e.account)}>
                      {short(e.account, 5)}
                    </a>
                  </td>
                  <td>{CATEGORIES[f.category]}</td>
                  <td>
                    <Sev n={f.severity} />
                  </td>
                  <td>
                    <Votes yes={f.confirmVotes} no={f.rejectVotes} threshold={thresholdOf(e.net.chainId)} />
                  </td>
                  <td>{f.stake > 0n ? `${eth(f.stake)} ETH` : <span className="dim">committee</span>}</td>
                  <td className="muted">{ago(Number(f.timestamp) * 1000, now)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn sm bad" disabled={!member || !!busy} onClick={() => act(e, "confirmFlag", "Confirm vote")}>
                        Confirm
                      </button>
                      <button className="btn sm ok" disabled={!member || !!busy} onClick={() => act(e, "rejectFlag", "Reject vote")}>
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {wallet.address && claimable.data?.some((c) => c.amount > 0n) && (
        <div className="pb" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", borderTop: "1px solid var(--line)" }}>
          <span className="muted mono" style={{ fontSize: 12 }}>
            You have funds to claim:
          </span>
          {claimable.data
            .filter((c) => c.amount > 0n)
            .map((c) => (
              <button
                key={c.net.key}
                className="btn ok"
                disabled={!!busy}
                onClick={() =>
                  run("Withdraw", c.net.chainId, (w) => w.writeContract({ address: c.net.dep!.registry, abi: registryAbi, functionName: "withdraw" }))
                }
              >
                <ChainTag k={c.net.key} /> withdraw {eth(c.amount)} ETH
              </button>
            ))}
        </div>
      )}
    </Panel>
  );
}

const PAGE = 50;
// Within the same import block, show the most serious categories first.
const PRIORITY = [0, 5, 3, 2, 4, 1, 6];

export function ThreatRegistry({ onPick }: { onPick: (a: Address) => void }) {
  const now = useNow(5000);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const registry = useRegistry(seen);
  const db = useQuery({ queryKey: ["threatdb"], queryFn: loadThreatDb, staleTime: Infinity });
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(0);
  const [shown, setShown] = useState(PAGE);

  // One row per address: the record from the chain that governs it, plus where it is enforced.
  const rows = useMemo(() => {
    const by = new Map<string, RegistryEntry[]>();
    for (const e of registry.data ?? []) by.set(e.account, [...(by.get(e.account) ?? []), e]);
    return [...by.values()]
      .map((list) => {
        const origin = list.find((e) => Number(e.flag.sourceChainId) === e.net.chainId) ?? list[0];
        const label = db.data?.entries[origin.account.toLowerCase()]?.[0]?.[3] ?? "";
        return { origin, list, label };
      })
      .sort((a, b) => Number(b.origin.flag.timestamp - a.origin.flag.timestamp) || PRIORITY[b.origin.flag.category] - PRIORITY[a.origin.flag.category]);
  }, [registry.data, db.data]);

  const counts = useMemo(() => {
    const c = new Array(CATEGORIES.length).fill(0);
    rows.forEach((r) => isActiveStatus(r.origin.flag.status) && c[r.origin.flag.category]++);
    return c;
  }, [rows]);

  const needle = q.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      (!cat || r.origin.flag.category === cat) &&
      (!needle || r.origin.account.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle)),
  );

  return (
    <Panel
      idx="07"
      title="Threat registry"
      right={<span className="muted">{rows.length.toLocaleString()} addresses on-chain</span>}
      hint="Everything the registry knows. Imported from public feeds (OFAC, exploit trackers, ScamSniffer, Etherscan, MEW) by the committee, or reported by users. Click a row to inspect it."
    >
      <div className="reg-tools" ref={ref}>
        <input
          className="input"
          placeholder="Search address or label, e.g. “Ronin”, “Tornado”, “Multichain”…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(PAGE);
          }}
        />
        <div className="cat-filter">
          <button className={cat === 0 ? "on" : ""} onClick={() => setCat(0)}>
            ALL <span>{rows.length.toLocaleString()}</span>
          </button>
          {CATEGORIES.slice(1).map((c, i) => (
            <button key={c} className={`${cat === i + 1 ? "on" : ""} c${i + 1}`} onClick={() => (setCat(cat === i + 1 ? 0 : i + 1), setShown(PAGE))}>
              {c.replace("_", " ")} <span>{counts[i + 1].toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 520 }}>
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Label / source</th>
              <th>Category</th>
              <th>Sev</th>
              <th>Status</th>
              <th>Enforced on</th>
              <th>Flagged</th>
            </tr>
          </thead>
          <tbody>
            {registry.isLoading && (
              <tr>
                <td colSpan={7} className="empty">
                  loading registry…
                </td>
              </tr>
            )}
            {!registry.isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Nothing matches.
                </td>
              </tr>
            )}
            {filtered.slice(0, shown).map(({ origin, list, label }) => {
              const f = origin.flag;
              return (
                <tr key={origin.account} className="click" onClick={() => onPick(origin.account)}>
                  <td>{short(origin.account, 6)}</td>
                  <td className="muted label-cell" title={label}>
                    {label || "user report"}
                  </td>
                  <td>
                    <span className={`cat c${f.category}`}>{CATEGORIES[f.category]}</span>
                  </td>
                  <td>
                    <Sev n={f.severity} />
                  </td>
                  <td className={f.status === 2 ? "red" : f.status === 1 ? "amber" : "muted"}>{STATUSES[f.status]}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      {NETS_READY.map((n) => {
                        const e = list.find((x) => x.net.chainId === n.chainId);
                        const on = e && isActiveStatus(e.flag.status);
                        return (
                          <span key={n.key} style={{ opacity: on ? 1 : 0.25 }} title={on ? `active on ${n.name}` : `not yet on ${n.name}`}>
                            <ChainTag k={n.key} />
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="muted">{ago(Number(f.timestamp) * 1000, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > shown && (
        <div className="pb" style={{ textAlign: "center", borderTop: "1px solid var(--line)" }}>
          <button className="btn sm" onClick={() => setShown((s) => s + PAGE * 4)}>
            show more ({(filtered.length - shown).toLocaleString()} left)
          </button>
        </div>
      )}
    </Panel>
  );
}
