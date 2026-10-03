import { useEffect, useState } from "react";
import { formatUnits, parseUnits, zeroAddress, type Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { guardAbi } from "../../../shared/abis";
import type { ChainKey } from "../../../shared/chains";
import { NETS } from "../config";
import { CATEGORIES, NETS_READY, explainError, guardedTokenAbi, short, toAddr, txUrl } from "../lib/chainguard";
import { useWallet } from "../lib/wallet";
import { ChainTag, Panel, useTx } from "./ui";

type TokenKey = "usdg" | "stock";
const TOKENS: Record<TokenKey, { symbol: string; decimals: number; name: string }> = {
  usdg: { symbol: "USDG", decimals: 6, name: "Global Dollar (demo)" },
  stock: { symbol: "TSLA", decimals: 18, name: "Tesla Stock Token (demo)" },
};

interface Outcome {
  tone: "ok" | "bad" | "warn";
  text: string;
  hash?: string;
}

export function FirewallTest({ prefill }: { prefill: Address | null }) {
  const wallet = useWallet();
  const { run, busy } = useTx();
  const [chain, setChain] = useState<ChainKey>(NETS_READY.at(-1)?.key ?? "robinhood");
  const [token, setToken] = useState<TokenKey>("usdg");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("100");
  const [force, setForce] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const net = NETS[chain];
  const t = TOKENS[token];
  const tokenAddr = net.dep?.[token];
  const parsed = toAddr(to);
  const recipient = parsed ?? to.trim();

  useEffect(() => {
    if (prefill) setTo(prefill);
  }, [prefill]);
  const recipientOk = parsed !== null;

  const balance = useQuery({
    queryKey: ["balance", chain, token, wallet.address],
    enabled: !!wallet.address && !!tokenAddr,
    refetchInterval: 4000,
    queryFn: () => net.client.readContract({ address: tokenAddr!, abi: guardedTokenAbi, functionName: "balanceOf", args: [wallet.address!] }),
  });

  const preview = useQuery({
    queryKey: ["preview", chain, wallet.address, recipient],
    enabled: recipientOk && !!net.dep,
    refetchInterval: 3000,
    queryFn: () =>
      net.client.readContract({
        address: net.dep!.guard,
        abi: guardAbi,
        functionName: "preview",
        args: [wallet.address ?? zeroAddress, recipient as Address],
      }),
  });
  const [allowed, worst, pCat, pSev] = preview.data ?? [true, zeroAddress, 0, 0];

  const faucet = () => run(`${t.symbol} faucet`, net.chainId, (w) => w.writeContract({ address: tokenAddr!, abi: guardedTokenAbi, functionName: "faucet" }));

  const send = async () => {
    setOutcome(null);
    const value = parseUnits(amount || "0", t.decimals);
    const args = [recipient as Address, value] as const;

    if (force) {
      // Broadcast with a fixed gas limit so the revert lands on-chain (visible in the explorer).
      let reason = "";
      try {
        await net.client.simulateContract({ account: wallet.address!, address: tokenAddr!, abi: guardedTokenAbi, functionName: "transfer", args });
      } catch (e) {
        reason = explainError(e);
      }
      try {
        const w = await wallet.writer(net.chainId);
        const hash = await w.writeContract({ address: tokenAddr!, abi: guardedTokenAbi, functionName: "transfer", args, gas: 300_000n });
        const r = await net.client.waitForTransactionReceipt({ hash });
        setOutcome(
          r.status === "success"
            ? { tone: "ok", text: `Transfer of ${amount} ${t.symbol} to ${short(recipient, 6)} succeeded`, hash }
            : { tone: "bad", text: `Reverted on-chain — ${reason || "ComplianceGuard rejected the transfer"}`, hash },
        );
        balance.refetch();
      } catch (e) {
        setOutcome({ tone: "bad", text: explainError(e) });
      }
      return;
    }

    // Simulate on our own RPC first: browser wallets often drop the revert data, which hides the AddressBlocked reason.
    const res = await run(`${t.symbol} transfer`, net.chainId, async (w) => {
      await net.client.simulateContract({ account: wallet.address!, address: tokenAddr!, abi: guardedTokenAbi, functionName: "transfer", args });
      return w.writeContract({ address: tokenAddr!, abi: guardedTokenAbi, functionName: "transfer", args });
    });
    if (res.ok) {
      setOutcome({
        tone: pSev > 0 ? "warn" : "ok",
        text:
          pSev > 0
            ? `Transfer went through with a yellow flag — ComplianceWarning emitted (${CATEGORIES[pCat]} sev ${pSev})`
            : `Transfer of ${amount} ${t.symbol} to ${short(recipient, 6)} cleared compliance`,
        hash: res.hash,
      });
      balance.refetch();
    } else {
      setOutcome({ tone: "bad", text: res.error ?? "failed" });
    }
  };

  const url = outcome?.hash ? txUrl(net, outcome.hash) : null;

  return (
    <Panel
      idx="05"
      id="firewall"
      title="Firewall test"
      right={<span className="muted">guarded ERC-20 transfer</span>}
      hint={
        <>
          Send demo <b>USDG</b> or tokenized <b>TSLA</b> and watch the token enforce the registry. 1) Click <b>Faucet</b> for free test tokens.
          2) Paste a recipient. The line below predicts the outcome. 3) <b>Send</b>. Severity 3 reverts inside the token contract.
        </>
      }
    >
      <div className="pb form">
        <div className="row-2">
          <div className="field">
            <span>Network</span>
            <div className="seg">
              {NETS_READY.map((n) => (
                <button key={n.key} type="button" className={chain === n.key ? "on" : ""} onClick={() => setChain(n.key)}>
                  <ChainTag k={n.key} /> {n.short}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Token</span>
            <div className="seg">
              {(Object.keys(TOKENS) as TokenKey[]).map((k) => (
                <button key={k} type="button" className={token === k ? "on" : ""} onClick={() => setToken(k)} title={TOKENS[k].name}>
                  {TOKENS[k].symbol}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="field">
          <span>Recipient</span>
          <input
            className={`input ${recipient && !recipientOk ? "bad" : ""}`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>

        {recipientOk && preview.error && <div className="result bad">Preview failed: {explainError(preview.error)}</div>}
        {recipientOk && preview.data && (
          <div className="preview-line">
            <span className={`dot ${!allowed ? "red" : pSev > 0 ? "amber" : "green"}`} />
            {!allowed ? (
              <span className="red">
                would REVERT — {short(worst, 5)} is {CATEGORIES[pCat]} (sev {pSev})
              </span>
            ) : pSev > 0 ? (
              <span className="amber">
                allowed with yellow flag — {short(worst, 5)} {CATEGORIES[pCat]} (sev {pSev})
              </span>
            ) : (
              <span className="green">counterparties clean — transfer allowed</span>
            )}
          </div>
        )}

        <div className="row-2" style={{ alignItems: "end" }}>
          <label className="field">
            <span>
              Amount ({t.symbol}){" "}
              {balance.data !== undefined && (
                <span className="dim" style={{ textTransform: "none" }}>
                  · bal {Number(formatUnits(balance.data, t.decimals)).toLocaleString()}
                </span>
              )}
            </span>
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={faucet} disabled={!wallet.address || !!busy} style={{ height: 41 }}>
              Faucet
            </button>
            <button
              className={`btn ${allowed ? "ok" : "bad"}`}
              onClick={send}
              disabled={!wallet.address || !recipientOk || !!busy}
              style={{ height: 41, flex: 1 }}
            >
              {busy === `${t.symbol} transfer` ? "Sending…" : `Send ${t.symbol}`}
            </button>
          </div>
        </div>
        <label className="muted mono" style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          broadcast even if simulation fails (puts the revert on-chain for the explorer)
        </label>
        {!wallet.address && <div className="result info">Connect a wallet to try transfers.</div>}
        {outcome && (
          <div className={`result ${outcome.tone}`}>
            {outcome.tone === "bad" ? "✕ " : outcome.tone === "warn" ? "⚠ " : "✓ "}
            {outcome.text}
            {outcome.hash && (
              <>
                {" · "}
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    tx {short(outcome.hash, 6)}
                  </a>
                ) : (
                  <b>tx {short(outcome.hash, 6)}</b>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
