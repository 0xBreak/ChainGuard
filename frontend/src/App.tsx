import { useState } from "react";
import type { Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { MODE, NET_LIST } from "./config";
import { useFeed } from "./hooks/data";
import { loadThreatDb } from "./lib/intel";
import { Header } from "./components/Header";
import { SearchHero, RiskResult, type ReportDraft } from "./components/RiskChecker";
import { LiveFeed } from "./components/LiveFeed";
import { NetworkStatus } from "./components/NetworkStatus";
import { SubmitFlag } from "./components/SubmitFlag";
import { FirewallTest } from "./components/FirewallTest";
import { CommitteeDesk, ThreatRegistry } from "./components/Committee";
import { HowItWorks, StartHere } from "./components/Guide";
import { SectionTitle } from "./components/ui";

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export default function App() {
  const [target, setTarget] = useState<Address | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const { events, fresh, loaded } = useFeed();
  const db = useQuery({ queryKey: ["threatdb"], queryFn: loadThreatDb, staleTime: Infinity });

  const check = (a: Address) => {
    setTarget(a);
    document.getElementById("verdict")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const report = (d: ReportDraft) => {
    setDraft({ ...d });
    setTimeout(() => scrollTo("report"), 50);
  };

  const missing = NET_LIST.filter((n) => !n.dep);

  return (
    <>
      <Header />
      <main className="wrap" id="top">
        {missing.length > 0 && (
          <div className="result bad" style={{ marginTop: 16 }}>
            No {MODE} deployment found for {missing.map((n) => n.name).join(", ")}. Run{" "}
            <b>scripts/{MODE === "local" ? "local-up.sh" : "deploy-testnet.sh"}</b>.
          </div>
        )}
        <SearchHero target={target} onCheck={check} />
        <HowItWorks />
        {!target && <StartHere onCheck={check} />}

        <div className="grid-main" id="verdict">
          <RiskResult target={target} onReport={report} onTest={() => scrollTo("firewall")} />
          <LiveFeed events={events} fresh={fresh} loaded={loaded} onPick={check} />
        </div>
        {target && <StartHere onCheck={check} />}

        <SectionTitle idx="//" title="Try it" sub="Send tokens through the firewall, or report a threat yourself." />
        <div className="grid-2">
          <FirewallTest prefill={target} />
          <SubmitFlag prefill={target} draft={draft} onFlagged={check} />
        </div>

        <SectionTitle idx="//" title="Multichain sync" sub="One logical registry on Arbitrum Sepolia and Robinhood Chain." />
        <NetworkStatus />

        <SectionTitle idx="//" title="Governance" sub="Who decides what gets blocked, and what is already blocked." />
        <div style={{ display: "grid", gap: 16 }}>
          <CommitteeDesk onPick={check} />
          <ThreatRegistry onPick={check} />
        </div>

        <footer className="foot">
          <div>
            <b>Data sources</b>
            <ul>
              {db.data?.sources.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.name}
                  </a>{" "}
                  <span className="dim">· {s.count.toLocaleString()} addresses</span>
                </li>
              ))}
              <li>
                <a href="https://gopluslabs.io" target="_blank" rel="noreferrer">
                  GoPlus address security API
                </a>{" "}
                <span className="dim">· live lookup (SlowMist, BlockSec, …)</span>
              </li>
            </ul>
            {db.data && <span className="dim">feeds compiled {new Date(db.data.generatedAt).toLocaleString()}</span>}
          </div>
          <div style={{ textAlign: "right" }}>
            CHAINGUARD · on-chain compliance firewall for tokenized assets
            <br />
            {NET_LIST.map((n) => `${n.name} ${n.chainId}`).join(" · ")} · {MODE}
          </div>
        </footer>
      </main>
    </>
  );
}
