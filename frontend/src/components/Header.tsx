import { useEffect, useRef, useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import { DEV_ACCOUNTS, MODE } from "../config";
import { short } from "../lib/chainguard";
import { useWallet } from "../lib/wallet";
import { useStats } from "../hooks/data";
import { useToast } from "./ui";

export function Shield({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2 4 7v8c0 7.5 5.1 13.6 12 15 6.9-1.4 12-7.5 12-15V7z" fill="none" stroke="#ff3b3b" strokeWidth="2" />
      <path d="M11 16.5l3.5 3.5L21.5 13" fill="none" stroke="#ff3b3b" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}

export function Header() {
  const { data: stats } = useStats();
  return (
    <header className="top">
      <div className="top-in">
        <div className="brand">
          <Shield />
          <span>
            CHAINGUARD
            <br />
            <small>compliance firewall</small>
          </span>
        </div>
        <div className="top-mid">
          {stats?.map((s) => (
            <span className="ticker" key={s.net.key}>
              <span className={`chain-tag ${s.net.key}`}>{s.net.short}</span>
              blk <b>#{s.head.toString()}</b>
            </span>
          ))}
        </div>
        <span className={`pill ${MODE === "local" ? "amber" : "green"}`}>{MODE === "local" ? "local devnet" : "testnet"}</span>
        <WalletButton />
      </div>
    </header>
  );
}

function WalletButton() {
  const w = useWallet();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const connect = async () => {
    setOpen(false);
    try {
      await w.connectInjected();
    } catch (e) {
      toast({ kind: "bad", body: (e as Error).message });
    }
  };

  return (
    <div className="wallet" ref={ref}>
      <button className={`btn ${w.address ? "" : "primary"}`} onClick={() => setOpen((o) => !o)}>
        {w.address ? (
          <>
            <span className="dot green" /> {w.kind === "dev" ? w.label : short(w.address)}
          </>
        ) : (
          "Connect wallet"
        )}
      </button>
      {open && (
        <div className="menu">
          {w.address && (
            <>
              <div className="lbl">connected</div>
              <button disabled>
                <span>{w.label}</span>
                <span className="muted">{short(w.address)}</span>
              </button>
              <hr />
            </>
          )}
          <button onClick={connect}>
            <span>Browser wallet</span>
            <span className="muted">injected</span>
          </button>
          {DEV_ACCOUNTS.length > 0 && (
            <>
              <div className="lbl">local dev accounts</div>
              {DEV_ACCOUNTS.map((a, i) => (
                <button
                  key={a.label}
                  onClick={() => {
                    w.useDevAccount(i);
                    setOpen(false);
                  }}
                >
                  <span>{a.label}</span>
                  <span className="muted">{short(privateKeyToAccount(a.key).address)}</span>
                </button>
              ))}
            </>
          )}
          {w.address && (
            <>
              <hr />
              <button
                onClick={() => {
                  w.disconnect();
                  setOpen(false);
                }}
              >
                <span className="red">Disconnect</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
