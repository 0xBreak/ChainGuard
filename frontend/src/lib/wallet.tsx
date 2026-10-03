import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, http, walletActions, type Account, type Address, type Chain, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { getConnectorClient, switchChain } from "wagmi/actions";
import { DEV_ACCOUNTS, netById, wagmiConfig } from "../config";

export type Writer = WalletClient<Transport, Chain, Account>;

interface WalletState {
  address: Address | null;
  label: string | null;
  kind: "injected" | "dev" | null;
  connectInjected: () => Promise<void>;
  useDevAccount: (index: number) => void;
  disconnect: () => void;
  /** A wallet client bound to `chainId`, switching the injected wallet's network if needed. */
  writer: (chainId: number) => Promise<Writer>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect } = useConnect();
  const { mutate: disconnectInjected } = useDisconnect();
  const [devIndex, setDevIndex] = useState<number | null>(null);

  const dev = devIndex === null ? null : DEV_ACCOUNTS[devIndex];
  const devAccount = useMemo(() => (dev ? privateKeyToAccount(dev.key) : null), [dev]);

  const value: WalletState = {
    address: devAccount?.address ?? conn.address ?? null,
    label: dev?.label ?? (conn.address ? conn.connector?.name ?? "Wallet" : null),
    kind: devAccount ? "dev" : conn.address ? "injected" : null,
    async connectInjected() {
      setDevIndex(null);
      const connector = connectors[0];
      if (!connector) throw new Error("No browser wallet found");
      await connect({ connector });
    },
    useDevAccount(i) {
      setDevIndex(i);
    },
    disconnect() {
      setDevIndex(null);
      disconnectInjected();
    },
    async writer(chainId) {
      const net = netById(chainId);
      if (!net) throw new Error(`Unknown chain ${chainId}`);
      if (devAccount) {
        return createWalletClient({ account: devAccount, chain: net.chain, transport: http(net.chain.rpcUrls.default.http[0]) });
      }
      if (!conn.address) throw new Error("Connect a wallet first");
      if (conn.chainId !== chainId) await switchChain(wagmiConfig, { chainId: chainId as never });
      const client = await getConnectorClient(wagmiConfig, { chainId: chainId as never });
      return client.extend(walletActions) as unknown as Writer;
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
