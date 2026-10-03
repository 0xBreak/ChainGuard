import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { createConfig, injected } from "wagmi";
import { CHAINS, CHAIN_KEYS, type ChainKey, type Deployment, type Mode } from "../../shared/chains";

export const MODE: Mode = import.meta.env.VITE_MODE === "testnet" ? "testnet" : "local";
/** Empty in the public build: the relayer is not reachable from visitors' browsers. */
export const RELAYER_URL: string = import.meta.env.VITE_RELAYER_URL ?? "";

const files = import.meta.glob<Deployment>("../../contracts/deployments/*/*.json", { eager: true, import: "default" });

function deploymentFor(chainId: number): Deployment | null {
  return files[`../../contracts/deployments/${MODE}/${chainId}.json`] ?? null;
}

export interface Net {
  key: ChainKey;
  name: string;
  short: string;
  chainId: number;
  chain: Chain;
  explorer: string | null;
  dep: Deployment | null;
  client: PublicClient;
}

export const NETS: Record<ChainKey, Net> = Object.fromEntries(
  CHAIN_KEYS.map((key) => {
    const meta = CHAINS[key];
    const rpc = import.meta.env[`VITE_RPC_${key.toUpperCase()}`] || meta.rpc[MODE];
    const explorer = meta.explorer[MODE];
    const chain = defineChain({
      id: meta.chainId,
      name: MODE === "local" ? `${meta.name} (local)` : meta.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
      blockExplorers: explorer ? { default: { name: "Explorer", url: explorer } } : undefined,
      testnet: true,
    });
    const net: Net = {
      key,
      name: meta.name,
      short: meta.short,
      chainId: meta.chainId,
      chain,
      explorer,
      dep: deploymentFor(meta.chainId),
      client: createPublicClient({ chain, transport: http(rpc), pollingInterval: 1000 }) as PublicClient,
    };
    return [key, net];
  }),
) as Record<ChainKey, Net>;

export const NET_LIST = CHAIN_KEYS.map((k) => NETS[k]);
export const netById = (chainId: number) => NET_LIST.find((n) => n.chainId === chainId);

const [c0, c1] = NET_LIST.map((n) => n.chain) as [Chain, Chain];
export const wagmiConfig = createConfig({
  chains: [c0, c1],
  connectors: [injected()],
  transports: Object.fromEntries(NET_LIST.map((n) => [n.chainId, http(n.chain.rpcUrls.default.http[0])])),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

/** Anvil's well-known dev keys, used only against the local stack (never on a public network). */
export const DEV_ACCOUNTS =
  MODE === "local"
    ? ([
        { label: "Committee #1", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
        { label: "Committee #2", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
        { label: "Committee #3", key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
        { label: "Reporter", key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" },
        { label: "Trader", key: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" },
      ] as const)
    : [];
