import type { Address } from "viem";
import { MODE, NET_LIST } from "../config";
import { DEMO_TARGETS } from "../lib/intel";
import { useWallet } from "../lib/wallet";

const STEPS = [
  {
    n: "1",
    title: "Registry",
    text: "One on-chain list of risky addresses: sanctions, exploits, phishing, mixers, scams. Each entry has a category and a severity from 1 to 3.",
  },
  {
    n: "2",
    title: "Firewall",
    text: "Tokens such as USDG and tokenized stocks ask the registry on every transfer. Severity 3 makes the transfer revert. Severity 1–2 lets it through with a warning.",
  },
  {
    n: "3",
    title: "Staked reports",
    text: "Anyone can report an address by staking ETH. A 2-of-3 committee confirms the report (stake back plus a reward) or rejects it (stake slashed). Spam costs money.",
  },
  {
    n: "4",
    title: "Multichain",
    text: `A relayer mirrors every flag between ${NET_LIST.map((n) => n.name).join(" and ")} within seconds, so one report protects both chains.`,
  },
];

export function HowItWorks() {
  return (
    <div className="how">
      {STEPS.map((s) => (
        <div key={s.n} className="how-step">
          <span className="how-n">{s.n}</span>
          <div>
            <b>{s.title}</b>
            <p>{s.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export function StartHere({ onCheck }: { onCheck: (a: Address) => void }) {
  const wallet = useWallet();
  const kelp = DEMO_TARGETS[0];
  const steps: { title: string; body: string; action: string; run: () => void; done?: boolean }[] = [
    {
      title: "Check a known hacker",
      body: `The ${kelp.label} address is BLOCKED on-chain, with its history and threat-feed matches.`,
      action: "Check it",
      run: () => onCheck(kelp.address),
    },
    {
      title: MODE === "local" ? "Pick a demo wallet" : "Connect your wallet",
      body:
        MODE === "local"
          ? "Top right → choose “Trader”. Local demo accounts are pre-funded, so you don't need MetaMask."
          : "Use MetaMask on Arbitrum Sepolia or Robinhood Chain testnet. You'll need a little test ETH for gas (faucet links below).",
      action: wallet.address ? "Connected ✓" : "Open wallet menu",
      run: () => (document.querySelector(".wallet > .btn") as HTMLButtonElement | null)?.click(),
      done: !!wallet.address,
    },
    {
      title: "Try to pay the hacker",
      body: "Firewall test → Faucet (free demo USDG) → Send. The token itself rejects the transfer. Then send to a clean address, which goes through.",
      action: "Go to Firewall test",
      run: () => go("firewall"),
    },
    {
      title: "Report a threat that isn't blocked yet",
      body: "Check the Bybit exploiter: the threat feeds know it but the registry doesn't (KNOWN THREAT). Click “Report to registry”, then stake and submit. It starts as a soft warning.",
      action: "Check Bybit exploiter",
      run: () => onCheck(DEMO_TARGETS[1].address),
    },
    {
      title: "Act as the committee",
      body:
        MODE === "local"
          ? "Switch to Committee #1, then Committee #2, and confirm the report. Within seconds the address is blocked on both chains."
          : "Committee members confirm the report in Governance. After quorum, the relayer syncs it to the other chain.",
      action: "Go to Governance",
      run: () => go("governance"),
    },
  ];

  return (
    <section className="panel start" id="start">
      <header className="ph">
        <span className="idx">▶</span>
        <h2>New here? 60-second walkthrough</h2>
        <span className="grow" />
        <span className="muted">{MODE === "local" ? "local demo · nothing costs real money" : "testnet · test ETH only"}</span>
      </header>
      <ol className="start-steps">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""}>
            <span className="start-n">{s.done ? "✓" : i + 1}</span>
            <div className="start-body">
              <b>{s.title}</b>
              <p>{s.body}</p>
            </div>
            <button className="btn sm" onClick={s.run} disabled={s.done}>
              {s.action}
            </button>
          </li>
        ))}
      </ol>
      {MODE === "testnet" && (
        <p className="hint" style={{ borderTop: "1px solid var(--line)" }}>
          Test ETH: <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">Robinhood Chain faucet</a> ·{" "}
          <a href="https://www.alchemy.com/faucets/arbitrum-sepolia" target="_blank" rel="noreferrer">Arbitrum Sepolia faucet</a>
        </p>
      )}
    </section>
  );
}
