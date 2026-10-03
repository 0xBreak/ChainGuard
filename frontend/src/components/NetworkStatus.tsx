import { NET_LIST } from "../config";
import { ago, eth, short } from "../lib/chainguard";
import { useLastMirror, useNow, useRelayer, useStats } from "../hooks/data";
import { Addr, ChainTag, Panel } from "./ui";

export function NetworkStatus() {
  const now = useNow(500);
  const stats = useStats();
  const relayer = useRelayer();
  const rel = relayer.data;
  const lastMirror = useLastMirror();

  // Registries are mirrors of one list, so the larger active count is the number of distinct live threats (± sync lag).
  const uniqueActive = (stats.data ?? []).reduce((m, s) => (s.activeFlags > m ? s.activeFlags : m), 0n);
  // Flags observed on one chain but not yet written to the other.
  // Without access to the relayer (public site), compare the two registries directly.
  const actives = (stats.data ?? []).map((s) => s.activeFlags);
  const chainDrift = actives.length === 2 ? Number(actives[0] > actives[1] ? actives[0] - actives[1] : actives[1] - actives[0]) : 0;
  const drift = rel ? rel.chains.reduce((a, c) => a + (c.queued ?? 0), 0) : chainDrift;
  const newestMirror = Math.max(0, ...Object.values(lastMirror.data ?? {}).map((t) => t ?? 0)) || null;

  const sum = (f: (s: NonNullable<typeof stats.data>[number]) => bigint) => (stats.data ?? []).reduce((a, s) => a + f(s), 0n);
  const relayerLive = !!rel && rel.chains.every((c) => now - c.lastPollAt < 6000);
  const lastLatency = rel?.recent.find((r) => r.latencyMs !== null)?.latencyMs;
  const [left, right] = NET_LIST;

  const card = (key: typeof left.key) => {
    const net = NET_LIST.find((n) => n.key === key)!;
    const s = stats.data?.find((x) => x.net.key === key);
    const rc = rel?.chains.find((c) => c.key === key);
    const synced = rc ? now - rc.lastPollAt < 6000 : !!s;
    const tone = !net.dep ? "red" : stats.error ? "red" : synced ? "green" : "amber";
    const mirroredIn = lastMirror.data?.[key] ?? null;
    return (
      <div className="net-card">
        <h3>
          <span className={`dot ${tone}`} />
          {net.name}
          <ChainTag k={net.key} />
        </h3>
        <div className="meta">
          chain {net.chainId} · registry {net.dep ? <Addr a={net.dep.registry} net={net} /> : <span className="red">not deployed</span>}
        </div>
        <div className="kv">
          <div>
            <span>Head</span>
            <b>{s ? `#${s.head}` : "—"}</b>
          </div>
          <div>
            <span>{rc ? "Last synced" : "Last flag synced in"}</span>
            <b className={synced ? "green" : "amber"}>{rc ? ago(rc.lastPollAt, now) : mirroredIn ? ago(mirroredIn, now) : "none yet"}</b>
          </div>
          <div>
            <span>Active / mirrored</span>
            <b>
              {s ? `${s.activeFlags} / ${s.mirroredFlags}` : "—"}
            </b>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Panel
      idx="03"
      title="Network status"
      hint="Both registries are one logical list. A relayer copies every new or changed flag to the other chain: within seconds when it runs live, or every few minutes from the scheduled GitHub Actions job. One report protects both chains."
      right={rel ? <span className="muted">relayer {short(rel.relayer)} · live</span> : <span className="muted">relayer runs on a schedule · status read from the chains</span>}
    >
      <div className="net">
        {card(left.key)}
        <div className="bridge">
          {(() => {
            const tone = !stats.data ? "amber" : drift === 0 ? "green" : "amber";
            return (
              <span className={`pill ${tone}`}>
                <span className={`dot ${tone}`} />
                {!stats.data ? "checking…" : drift === 0 ? "registries in sync" : `${drift.toLocaleString()} awaiting sync`}
              </span>
            );
          })()}
          <div className={`wire ${relayerLive || drift > 0 ? "live" : ""}`} />
          <div className={`wire rev ${relayerLive || drift > 0 ? "live" : ""}`} />
          {rel ? (
            <span>
              last mirror <b>{lastLatency != null ? `${(lastLatency / 1000).toFixed(1)}s` : "—"}</b>
              <br />
              {rel.chains.reduce((a, c) => a + c.mirrorsSent, 0).toLocaleString()} flags relayed
            </span>
          ) : (
            <span>
              active flags <b>{actives.map((a) => Number(a).toLocaleString()).join(" = ")}</b>
              <br />
              last cross-chain sync {ago(newestMirror, now)}
            </span>
          )}
        </div>
        {card(right.key)}
      </div>
      <div className="counters">
        <div className="counter">
          <span>Total flags</span>
          <b>{stats.data ? Number(sum((s) => s.totalFlags)).toLocaleString() : "—"}</b>
          <small>raised across chains</small>
        </div>
        <div className="counter">
          <span>Active threats</span>
          <b className="red">{stats.data ? Number(uniqueActive).toLocaleString() : "—"}</b>
          <small>unique addresses</small>
        </div>
        <div className="counter">
          <span>Reporters</span>
          <b>{stats.data ? sum((s) => s.uniqueReporters).toString() : "—"}</b>
          <small>staked at least once</small>
        </div>
        <div className="counter">
          <span>ETH at stake</span>
          <b>{stats.data ? eth(sum((s) => s.totalStaked), 3) : "—"}</b>
          <small>locked in pending flags</small>
        </div>
        <div className="counter">
          <span>Reward pool</span>
          <b className="green">{stats.data ? eth(sum((s) => s.rewardPool), 3) : "—"}</b>
          <small>funded by slashed stakes</small>
        </div>
      </div>
    </Panel>
  );
}
