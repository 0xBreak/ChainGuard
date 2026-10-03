import type { Address } from "viem";
import { ago, short, type ChainEvent } from "../lib/chainguard";
import { describe } from "../lib/events";
import { useNow } from "../hooks/data";
import { ChainTag, Panel } from "./ui";

export function LiveFeed({ events, fresh, loaded, onPick }: { events: ChainEvent[]; fresh: Set<string>; loaded: boolean; onPick: (a: Address) => void }) {
  const now = useNow();
  return (
    <Panel
      idx="02"
      title="Live threat feed"
      hint="Every registry event on both chains as it happens: reports, votes, cross-chain syncs, warnings. Click a row to check that address."
      right={
        <span className="nowrap" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="dot green" /> streaming
        </span>
      }
    >
      <div className="feed">
        {events.length === 0 && (
          <div className="empty cursor">{loaded ? "No registry activity yet. Waiting for new events" : "loading recent on-chain history"}</div>
        )}
        {events.map((e) => {
          const d = describe(e);
          return (
            <div
              key={e.id}
              className={`feed-row ${fresh.has(e.id) ? "fresh" : ""}`}
              onClick={() => d.account && onPick(d.account)}
              title={d.account ? "Screen this address" : undefined}
            >
              <span className="t">{ago(e.time, now).replace(" ago", "")}</span>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <ChainTag k={e.net.key} />
                <span className={`ev ${d.tone === "muted" ? "muted" : d.tone}`}>{d.label}</span>
              </span>
              <span style={{ textAlign: "right" }}>{d.account && <span>{short(d.account, 5)}</span>}</span>
              <span className="who">{d.detail}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
