import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import type { ChainKey } from "../../../shared/chains";
import { netById, type Net } from "../config";
import { addrUrl, explainError, short, txUrl } from "../lib/chainguard";
import { useWallet, type Writer } from "../lib/wallet";

export function ChainTag({ k }: { k: ChainKey }) {
  return <span className={`chain-tag ${k}`}>{k === "arbitrum" ? "ARB" : "RH"}</span>;
}

export function Sev({ n }: { n: number }) {
  return (
    <span className={`sev s${n}`} title={`severity ${n}`}>
      <i />
      <i />
      <i />
    </span>
  );
}

export function Addr({ a, net, n = 4, full }: { a: string; net?: Net; n?: number; full?: boolean }) {
  const url = net ? addrUrl(net, a) : null;
  const text = full ? a : short(a, n);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" title={a}>
      {text}
    </a>
  ) : (
    <span title={a}>{text}</span>
  );
}

export function Panel(props: { idx?: string; title: string; right?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel ${props.className ?? ""}`} id={props.id}>
      <header className="ph">
        {props.idx && <span className="idx">{props.idx}</span>}
        <h2>{props.title}</h2>
        <span className="grow" />
        {props.right}
      </header>
      {props.hint && <p className="hint">{props.hint}</p>}
      {props.children}
    </section>
  );
}

export function SectionTitle({ idx, title, sub }: { idx: string; title: string; sub?: string }) {
  return (
    <div className="section-title">
      <span className="idx">{idx}</span>
      <h2>{title}</h2>
      {sub && <p>{sub}</p>}
      <span className="rule" />
    </div>
  );
}

// ---------------------------------------------------------------- toasts & transactions

interface Toast {
  id: number;
  kind: "ok" | "bad" | "info";
  body: ReactNode;
}
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-3), { ...t, id }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 7000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.body}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export interface TxResult {
  ok: boolean;
  hash?: Hex;
  error?: string;
}

/** Send a transaction on `chainId`, wait for it, toast the outcome, refresh on-chain queries. */
export function useTx() {
  const wallet = useWallet();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, chainId: number, send: (w: Writer) => Promise<Hex>): Promise<TxResult> => {
      const net = netById(chainId)!;
      setBusy(label);
      try {
        const w = await wallet.writer(chainId);
        const hash = await send(w);
        const receipt = await net.client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`Transaction reverted (${short(hash, 6)})`);
        const url = txUrl(net, hash);
        toast({
          kind: "ok",
          body: (
            <>
              ✓ {label} on {net.name}{" "}
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  {short(hash, 6)}
                </a>
              ) : (
                <span className="dim">{short(hash, 6)}</span>
              )}
            </>
          ),
        });
        qc.invalidateQueries();
        return { ok: true, hash };
      } catch (e) {
        const error = explainError(e);
        toast({ kind: "bad", body: `✕ ${label}: ${error}` });
        return { ok: false, error };
      } finally {
        setBusy(null);
      }
    },
    [wallet, toast, qc],
  );

  return { run, busy };
}
