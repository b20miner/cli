import type { Address } from "viem";
import { ACTIVE, type Campaign, type Position } from "./chain.ts";

/**
 * Whether this wallet can mine a campaign right now, and if not, what
 * happens next. Pure: decided from `Campaign` and `Position` alone, so the
 * same answer shows in `status`, in `tokens` and before `start`.
 *
 * The wallet on this computer sends every proof. Each proof credits the
 * "owner": by default that same wallet, or the user's own wallet when the
 * rewards go there (`to`, an address — the CLI never has its key). When
 * mining ends, the B20MINER relay finalizes the campaign, sends every owner
 * their tokens and opens the pool; with claim vesting the rest is claimed
 * later, with `b20miner claim` or, for the user's own wallet, on the
 * Launchpad with that wallet.
 */

/** "0x1234…abcd". */
export const shortAddress = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Where the tokens go, in a sentence: "this wallet" or "your wallet 0x1234…abcd". */
export const holderText = (to?: Address | null) => (to ? `your wallet ${shortAddress(to)}` : "this wallet");

export type Blocker = "not-open" | "not-started" | "closed" | "finalized" | "sold-out" | "quota-done" | "hourly";

export type Readiness = { readonly ready: true } | { readonly ready: false; readonly blocker: Blocker; readonly message: string; readonly next: string };

export function readiness(c: Campaign, p: Position, to?: Address | null): Readiness {
  if (c.status !== ACTIVE) {
    return { ready: false, blocker: "finalized", message: `Mining ${c.symbol} is over and the token has launched.`, next: deliveryNext(c, p, to) };
  }
  if (!c.opened) return { ready: false, blocker: "not-open", message: `Mining ${c.symbol} has not opened yet.`, next: "Run b20miner start again once it opens." };
  if (c.now < c.start) return { ready: false, blocker: "not-started", message: `Mining ${c.symbol} starts in ${formatDuration(c.start - c.now)}.`, next: "Run b20miner start again then." };
  if (c.now >= c.end) {
    return { ready: false, blocker: "closed", message: `The mining window of ${c.symbol} has closed.`, next: "The relay finalizes it and sends every miner their tokens; check with b20miner status." };
  }
  if (c.minedTotal >= c.miningReserve) {
    return { ready: false, blocker: "sold-out", message: `The mining reserve of ${c.symbol} is fully mined.`, next: "The relay finalizes it and sends every miner their tokens; check with b20miner status." };
  }
  if (p.mined >= c.capTokens) {
    const who = to ? `Your wallet ${shortAddress(to)} has` : "This wallet has";
    return { ready: false, blocker: "quota-done", message: `${who} mined its full ${c.symbol} quota.`, next: `Your tokens arrive in ${holderText(to)} when the pool opens.` };
  }
  if (p.quote.reward === 0n && c.hourlySchedule) {
    const wait = c.nextReleaseAt > c.now ? ` in ${formatDuration(c.nextReleaseAt - c.now)}` : " soon";
    return { ready: false, blocker: "hourly", message: `This hour's ${c.symbol} release is fully mined.`, next: `The next hour's share is released${wait}.` };
  }
  return { ready: true };
}

/** After mining: where the owner's tokens are (`to`: the user's own wallet, when the rewards go there). */
export function deliveryNext(c: Campaign, p: Position, to?: Address | null): string {
  const where = holderText(to);
  const claim = to ? `on the Launchpad (${APP_HOST}) with that wallet` : "with b20miner claim";
  if (p.mined === 0n) return `Nothing of it was mined for ${where}.`;
  if (c.status === ACTIVE) return `Your tokens arrive in ${where} when the pool opens.`;
  if (!c.distributionDone) return `The relay is sending every miner their tokens; they arrive in ${where} shortly.`;
  if (p.claimable > 0n) return `Part of your tokens can be claimed now ${claim}.`;
  if (p.claimed < p.mined && c.claimVestingDays > 0) return `The rest vests over time; claim it later ${claim}.`;
  return `Your tokens are in ${where}.`;
}

const APP_HOST = "launch.b20miner.xyz";

/** "3d 4h", "2h 15m", "45m", "30s". */
export function formatDuration(seconds: bigint): string {
  let s = Number(seconds < 0n ? 0n : seconds);
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3_600);
  s -= h * 3_600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Proofs left: ceil(remaining / reward per proof). */
export function proofsLeft(remaining: bigint, rewardPerProof: bigint): bigint {
  return rewardPerProof > 0n ? (remaining + rewardPerProof - 1n) / rewardPerProof : 0n;
}

/** What this wallet can still mine: its quota or the reserve left, whichever is smaller. */
export function leftToMine(c: Campaign, p: Position): bigint {
  const quota = c.capTokens > p.mined ? c.capTokens - p.mined : 0n;
  const reserve = c.miningReserve > c.minedTotal ? c.miningReserve - c.minedTotal : 0n;
  return quota < reserve ? quota : reserve;
}
