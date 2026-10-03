export type Mode = "local" | "testnet";
export type ChainKey = "arbitrum" | "robinhood";

export interface ChainMeta {
  key: ChainKey;
  name: string;
  short: string;
  chainId: number;
  rpc: Record<Mode, string>;
  explorer: Record<Mode, string | null>;
}

export const CHAINS: Record<ChainKey, ChainMeta> = {
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    short: "ARB",
    chainId: 421614,
    rpc: { testnet: "https://sepolia-rollup.arbitrum.io/rpc", local: "http://127.0.0.1:8545" },
    explorer: { testnet: "https://sepolia.arbiscan.io", local: null },
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    short: "RH",
    chainId: 46630,
    rpc: { testnet: "https://rpc.testnet.chain.robinhood.com/rpc", local: "http://127.0.0.1:8546" },
    explorer: { testnet: "https://explorer.testnet.chain.robinhood.com", local: null },
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

export interface Deployment {
  chainId: number;
  startBlock: number;
  registry: `0x${string}`;
  guard: `0x${string}`;
  usdg: `0x${string}`;
  stock: `0x${string}`;
}

export const CATEGORIES = ["NONE", "SANCTIONED", "PHISHING", "RUGPULL", "MIXER", "SCAM_REPORTED", "EXPLOIT"] as const;
export const STATUSES = ["NONE", "PENDING", "CONFIRMED", "REJECTED", "CLEARED"] as const;
export const isActiveStatus = (s: number) => s === 1 || s === 2;
