import type { Address } from "viem";
import { CATEGORIES, STATUSES, chainName, eth, short, type ChainEvent } from "./chainguard";

export type Tone = "red" | "green" | "amber" | "blue" | "muted";

export interface Described {
  label: string;
  tone: Tone;
  account: Address | null;
  detail: string;
}

const VOTE = ["", "CONFIRM", "REJECT", "CLEAR"];

export function describe(e: ChainEvent): Described {
  const a = e.args as Record<string, any>;
  const account = (a.account ?? null) as Address | null;
  switch (e.name) {
    case "AddressFlagged":
      return {
        label: "FLAGGED",
        tone: a.severity >= 3 ? "red" : "amber",
        account,
        detail: `${CATEGORIES[a.category]} · sev ${a.severity} · ${a.stake > 0n ? `reported by ${short(a.reporter)}, staked ${eth(a.stake)} ETH` : `public-feed entry submitted by committee member ${short(a.reporter)}`}`,
      };
    case "FlagVote":
      return { label: "VOTE", tone: "blue", account, detail: `${short(a.member)} → ${VOTE[a.action]} (round ${a.round})` };
    case "FlagConfirmed":
      return { label: "CONFIRMED", tone: "red", account, detail: a.payout > 0n ? `quorum reached · reporter paid ${eth(a.payout)} ETH` : "quorum reached · full severity enforced" };
    case "FlagRejected":
      return { label: "REJECTED", tone: "green", account, detail: `false flag · ${eth(a.slashed)} ETH stake slashed` };
    case "FlagExpired":
      return { label: "EXPIRED", tone: "muted", account, detail: `unresolved · ${eth(a.refunded)} ETH refunded` };
    case "AppealFiled":
      return { label: "APPEAL", tone: "amber", account, detail: `"${a.reason}"` };
    case "AddressCleared":
      return { label: "CLEARED", tone: "green", account, detail: `flag lifted by committee (round ${a.round})` };
    case "FlagMirrored":
      return {
        label: "SYNCED",
        tone: "blue",
        account,
        detail: `${STATUSES[a.status]} · ${CATEGORIES[a.category]} sev ${a.severity} ← ${chainName(a.sourceChainId)}`,
      };
    case "ComplianceWarning":
      return {
        label: "YELLOW FLAG",
        tone: "amber",
        account,
        detail: `transfer ${short(a.from)} → ${short(a.to)} allowed with warning (${CATEGORIES[a.category]} sev ${a.severity})`,
      };
    case "Withdrawal":
      return { label: "PAYOUT", tone: "muted", account: null, detail: `${short(a.to)} withdrew ${eth(a.amount)} ETH` };
    case "RewardPoolFunded":
      return { label: "POOL+", tone: "muted", account: null, detail: `reward pool +${eth(a.amount)} ETH` };
    default:
      return { label: e.name.toUpperCase(), tone: "muted", account, detail: "" };
  }
}
