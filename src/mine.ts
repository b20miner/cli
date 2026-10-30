import { randomBytes } from "node:crypto";
import { BaseError, ContractFunctionRevertedError, decodeEventLog, formatEther, formatUnits, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import type { NetworkConfig } from "./config.ts";
import { CAMPAIGN_ABI, readCampaign, readChallenge, walletClient, zeroBits, type Campaign, type Position } from "./chain.ts";
import { bufferedGasLimit, maxProofCost, proofSendValue, requiredBalance } from "./costs.ts";
import { startSearch, type Search } from "./hasher.ts";
import { deliveryNext, formatDuration, holderText, leftToMine, proofsLeft, readiness } from "./status.ts";
import { amber, bold, cobalt, dim, err, fault, muted, ok, rose, warn } from "./ui.ts";

/**
 * The mining loop for one Launchpad campaign. The wallet on this computer is
 * the miner that sends the proofs; the owner they credit is that same wallet
 * or, when the user chose it, the user's own wallet (`owner`, an address):
 * 1. re-check on-chain that the campaign can be mined (open, window, reserve,
 *    this wallet's quota, the hourly release) and that the wallet holds
 *    enough ETH;
 * 2. search for a proof against the wallet's current challenge. Anyone may
 *    mine for any owner, so the challenge is watched while searching: if
 *    another miner's proof for this wallet moves it, the search restarts on
 *    the new one instead of finishing a proof that would revert;
 * 3. before sending, re-read the challenge, simulate the call and check the
 *    worst-case cost against --max-cost (a proof is held, not sent, while
 *    gas is too expensive);
 * 4. send `submitProof` with the full-proof fee (any excess is refunded),
 *    wait for the receipt and print the reward recorded for the owner.
 * Ctrl+C stops the search at once; a transaction already sent is still
 * awaited before exit.
 */

/** Gas assumed before a proof exists to estimate with (a real proof uses less). */
const GAS_BEFORE_ESTIMATE = 250_000n;
const RECEIPT_TIMEOUT_MS = 180_000;
const CHALLENGE_WATCH_MS = 4_000;
const COST_WAIT_MS = 30_000;
const MAX_REVERTS_IN_A_ROW = 3;

function formatRate(hps: number): string {
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} kH/s`;
  return `${hps.toFixed(0)} H/s`;
}

function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** A token amount: "12,500 TEST1". */
export const amount = (wei: bigint, symbol: string, digits = 2) => `${Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol}`;

/** Contract errors that end the session: nothing more can be mined here from this wallet. */
const FATAL_REVERTS = new Set(["NotStarted", "WindowClosed", "NotOpened", "NotActive", "ReserveExhausted", "QuotaExhausted", "ZeroOwner"]);

function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
}

function describeRevert(error: unknown): string {
  const name = revertName(error);
  if (name === "StaleChallenge") return "Another proof for the same owner landed first (stale challenge).";
  if (name === "InvalidProof") return "The campaign rejected the proof as invalid.";
  if (name === "NotStarted") return "Mining has not started yet.";
  if (name === "NotOpened") return "Mining has not opened yet.";
  if (name === "WindowClosed") return "The mining window has closed.";
  if (name === "NotActive") return "Mining is over for this token.";
  if (name === "ReserveExhausted") return "The mining reserve is fully mined.";
  if (name === "QuotaExhausted") return "This wallet has mined its full quota.";
  if (name === "HourlyLimitReached") return "This hour's release is fully mined.";
  if (name === "InsufficientFee") return "The fee sent was too low.";
  if (name) return `The contract reverted with ${name}.`;
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

interface RewardedEvent {
  readonly reward: bigint;
  readonly fee: bigint;
  readonly minedOfOwner: bigint;
  readonly minedTotal: bigint;
}

export function findProofRewarded(logs: ReadonlyArray<{ address: string; data: Hex; topics: [] | [Hex, ...Hex[]] }>, campaign: Address, owner: Address, miningWallet: Address): RewardedEvent | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== campaign.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: CAMPAIGN_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "ProofRewarded") continue;
      const a = decoded.args;
      if (a.owner.toLowerCase() === owner.toLowerCase() && a.miner.toLowerCase() === miningWallet.toLowerCase()) {
        return { reward: a.reward, fee: a.fee, minedOfOwner: a.minedOfOwner, minedTotal: a.minedTotal };
      }
    } catch {
      // not our event
    }
  }
  return null;
}

/**
 * Base's public RPC is load-balanced: right after a block, one node may not
 * have it yet ("block not found", stale reads, 429/5xx). Transient read
 * failures are retried with a short backoff instead of ending the session.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await sleep(1000 + i * 750);
    }
  }
  throw last;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shortError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

export interface MineOptions {
  readonly workers: number;
  /** Stop after this many accepted proofs (0 = run until Ctrl+C, the quota or the reserve is done). */
  readonly maxProofs: number;
  /** Largest worst-case cost (gas + mining fee) one proof may have, in wei. */
  readonly maxCostWei: bigint;
  /** The wallet the proofs credit, when it is not this CLI's own (the user's wallet; address only). */
  readonly rewardsTo?: Address | null;
}

type Step = "continue" | "stop";

export async function mine(config: NetworkConfig, client: PublicClient, account: PrivateKeyAccount, first: Campaign, options: MineOptions): Promise<void> {
  const wallet = walletClient(config, account);
  const contract = first.campaign;
  const ref = { token: first.token, campaign: first.campaign };
  const to = options.rewardsTo && options.rewardsTo !== account.address ? options.rewardsTo : null;
  const owner = to ?? account.address;
  const where = holderText(to);
  const sym = first.symbol;
  const tty = process.stdout.isTTY === true;
  const clearLine = () => {
    if (tty) process.stdout.write("\r\x1b[2K");
  };
  const state = { stopRequested: false, txPending: false, search: null as Search | null };

  const onSigint = () => {
    if (state.stopRequested) {
      console.log(`\n${warn("Forced exit.")}`);
      process.exit(130);
    }
    state.stopRequested = true;
    state.search?.stop();
    clearLine();
    console.log(state.txPending ? warn("Stopping after the pending transaction confirms… (Ctrl+C again to force)") : warn("Stopping…"));
  };
  process.on("SIGINT", onSigint);

  console.log(
    `\n  ${bold(`Mining ${sym}`)} ${muted("·")} ${options.workers} worker${options.workers === 1 ? "" : "s"} ${muted("·")} ${zeroBits(first.powTarget)} leading zero bits ${muted("·")} ${rose(amount(first.rewardPerProof, sym, 1))} per proof ${muted("·")} fee ${formatEther(first.proofFee)} ETH ${muted(`· max ${formatEther(options.maxCostWei)} ETH per proof`)}`,
  );
  console.log(`  ${dim(to ? `Every proof credits your wallet ${owner}; this CLI wallet pays the fees. The tokens arrive there when the pool opens. Ctrl+C stops at once.` : "Every proof credits this wallet. Your tokens arrive here when the pool opens. Ctrl+C stops at once.")}\n`);

  let accepted = 0;
  let sessionReward = 0n;
  let sessionSpent = 0n;
  let revertsInARow = 0;
  let failures = 0;
  let lastMined: bigint | null = null;
  // Set inside the loop's closure, so TypeScript cannot follow it; read through `seen()`.
  let last: { c: Campaign; p: Position } | null = null;
  const seen = () => last as { c: Campaign; p: Position } | null;

  /** One proof: check, search, send, confirm. */
  const mineOnce = async (): Promise<Step> => {
    const read = await withRetry(() => readCampaign(client, ref, owner));
    const { c } = read;
    const p = read.p!;
    last = { c, p };
    lastMined = p.mined;
    const ready = readiness(c, p, to);
    if (!ready.ready) {
      if (ready.blocker === "hourly") {
        // The next hour's share comes by itself: wait for it instead of ending the session.
        const wait = c.nextReleaseAt > c.now ? Number(c.nextReleaseAt - c.now) : 60;
        console.log(`  ${amber("⏸")} ${muted(`${ready.message} Waiting ${formatDuration(BigInt(wait))} for the next release…`)}`);
        for (let t = 0; t < wait + 5 && !state.stopRequested; t++) await sleep(1000);
        return state.stopRequested ? "stop" : "continue";
      }
      console.log(warn(ready.message));
      console.log(`    ${ready.next}`);
      return "stop";
    }

    const [challenge, fees, balance] = await Promise.all([
      withRetry(() => readChallenge(client, contract, owner)),
      withRetry(() => client.estimateFeesPerGas()),
      withRetry(() => client.getBalance({ address: account.address })),
    ]);
    const quotedFee = p.quote.fee;
    const sendValue = proofSendValue(quotedFee, c.proofFee);
    const needed = requiredBalance(GAS_BEFORE_ESTIMATE, fees.maxFeePerGas, sendValue);
    if (balance < needed) {
      console.log(err(`Not enough ETH in the mining wallet: ${formatEther(balance)} ETH, need at least ${formatEther(needed)} ETH for the fee and gas.`));
      console.log(`    Send ${config.name} ETH to ${bold(account.address)} and start again.`);
      return "stop";
    }

    // Search, restarting nothing: if the challenge moves, this round ends and the next one starts on the new challenge.
    const seed = BigInt(`0x${randomBytes(6).toString("hex")}`);
    const search = startSearch(
      { chainId: BigInt(config.chainId), contract, owner, miner: account.address, challenge, target: c.powTarget },
      options.workers,
      (hashes, rate) => {
        if (tty) process.stdout.write(`\r\x1b[2K  ${cobalt("⛏")}  ${muted("searching")}  ${bold(formatRate(rate))}  ${muted(`${formatCount(hashes)} hashes`)}`);
      },
      seed,
    );
    state.search = search;
    let moved = false;
    const watch = setInterval(() => {
      readChallenge(client, contract, owner)
        .then((current) => {
          if (current.toLowerCase() !== challenge.toLowerCase()) {
            moved = true;
            search.stop();
          }
        })
        .catch(() => {
          // a missed check is fine; the pre-send check catches it
        });
    }, CHALLENGE_WATCH_MS);
    const proof = await search.result.finally(() => clearInterval(watch));
    state.search = null;
    clearLine();
    if (moved) {
      console.log(`  ${amber("↻")} ${muted("Another proof for the same owner landed; continuing on the new challenge.")}`);
      return "continue";
    }
    if (!proof) return "stop";

    console.log(
      `  ${rose("◆")} ${bold("Proof found")}  ${muted("nonce")} ${proof.nonce}  ${muted("hash")} ${proof.hash.slice(0, 18)}…  ${muted(`${formatCount(proof.hashesTried)} hashes · ${proof.seconds.toFixed(1)} s · ${formatRate(proof.hashesTried / Math.max(proof.seconds, 0.001))}`)}`,
    );

    // Pre-send: simulate. A stale answer is either a real move (another
    // miner) or a load-balanced RPC node one block behind; re-reading the
    // challenge tells them apart.
    let gasLimit: bigint | null = null;
    for (let attempt = 0; attempt < 4 && gasLimit === null; attempt++) {
      try {
        gasLimit = bufferedGasLimit(await client.estimateContractGas({ address: contract, abi: CAMPAIGN_ABI, functionName: "submitProof", args: [owner, challenge, proof.nonce], value: sendValue, account }));
      } catch (error) {
        const name = revertName(error);
        if (name && FATAL_REVERTS.has(name)) {
          console.log(err(describeRevert(error)));
          return "stop";
        }
        if (name === "StaleChallenge") {
          const current = await withRetry(() => readChallenge(client, contract, owner));
          if (current.toLowerCase() !== challenge.toLowerCase()) {
            console.log(`  ${amber("↻")} ${muted("Another proof for the same owner landed first; this one is dropped unsent.")}`);
            return "continue";
          }
        } else if (name === "HourlyLimitReached") {
          console.log(`  ${amber("⏸")} ${muted("This hour's release was mined out first; the proof was not sent.")}`);
          return "continue";
        } else if (name) {
          console.log(err(`${describeRevert(error)} The proof was not sent.`));
          return "continue";
        }
        await sleep(1500);
      }
    }
    gasLimit ??= bufferedGasLimit(GAS_BEFORE_ESTIMATE);

    // Cost cap: hold the proof (it stays valid while the challenge does) until gas is cheap enough.
    let maxFeePerGas = fees.maxFeePerGas;
    let maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    for (;;) {
      const worst = maxProofCost(gasLimit, maxFeePerGas, quotedFee);
      if (worst <= options.maxCostWei) break;
      console.log(warn(`Gas is expensive right now: up to ${formatEther(worst)} ETH for this proof, above your limit of ${formatEther(options.maxCostWei)} ETH. Holding the proof and checking again in 30 s.`));
      await sleep(COST_WAIT_MS);
      if (state.stopRequested) return "stop";
      const current = await withRetry(() => readChallenge(client, contract, owner));
      if (current.toLowerCase() !== challenge.toLowerCase()) {
        console.log(`  ${amber("↻")} ${muted("The challenge moved while the proof was held; searching again.")}`);
        return "continue";
      }
      const next = await withRetry(() => client.estimateFeesPerGas());
      maxFeePerGas = next.maxFeePerGas;
      maxPriorityFeePerGas = next.maxPriorityFeePerGas;
    }

    state.txPending = true;
    let receipt;
    try {
      let txHash: Hex;
      try {
        txHash = await wallet.writeContract({
          address: contract,
          abi: CAMPAIGN_ABI,
          functionName: "submitProof",
          args: [owner, challenge, proof.nonce],
          value: sendValue,
          gas: gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          chain: wallet.chain,
          account,
        });
      } catch (error) {
        console.log(err(`Could not send the proof: ${describeRevert(error)}`));
        return "stop";
      }
      console.log(`    ${muted("sent")} ${config.explorerTx(txHash)}`);
      receipt = await withRetry(() => client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS }), 3);
    } finally {
      state.txPending = false;
    }
    sessionSpent += receipt.gasUsed * receipt.effectiveGasPrice;

    if (receipt.status !== "success") {
      revertsInARow++;
      console.log(err(`${fault("Reverted")} in block ${receipt.blockNumber} (only gas was spent; the fee was not taken).`));
      if (revertsInARow >= MAX_REVERTS_IN_A_ROW) {
        console.log(err(`${MAX_REVERTS_IN_A_ROW} proofs in a row reverted. Stopping; check b20miner status.`));
        return "stop";
      }
      return "continue";
    }
    revertsInARow = 0;

    const event = findProofRewarded(receipt.logs, contract, owner, account.address);
    if (!event) {
      console.log(err("The transaction succeeded but carried no ProofRewarded event. Stopping to be safe."));
      return "stop";
    }

    accepted++;
    sessionReward += event.reward;
    sessionSpent += event.fee;
    lastMined = event.minedOfOwner;
    const cost = event.fee + receipt.gasUsed * receipt.effectiveGasPrice;
    const remaining = leftToMine({ ...c, minedTotal: event.minedTotal }, { ...p, mined: event.minedOfOwner });
    const left = proofsLeft(remaining, c.rewardPerProof);
    console.log(
      ok(`${bold("Accepted")}  ${rose(`+${amount(event.reward, sym, 1)}`)}  ${muted("mined")} ${bold(amount(event.minedOfOwner, sym))}  ${muted(`· ${amount(remaining, sym)} left (${left} proof${left === 1n ? "" : "s"}) · cost ${formatEther(cost)} ETH`)}`),
    );
    if (event.minedOfOwner >= c.capTokens) {
      console.log(ok(bold(`Quota complete: ${where} has mined everything it can of ${sym}.`)));
      return "stop";
    }
    if (event.minedTotal >= c.miningReserve) {
      console.log(ok(bold(`The ${sym} mining reserve is fully mined.`)));
      return "stop";
    }
    return options.maxProofs > 0 && accepted >= options.maxProofs ? "stop" : "continue";
  };

  try {
    while (!state.stopRequested) {
      try {
        if ((await mineOnce()) === "stop") break;
        failures = 0;
      } catch (error) {
        // Never end a session on a transient network error: say what happened,
        // wait and carry on. Stop after repeated failures.
        state.search?.stop();
        state.search = null;
        clearLine();
        failures++;
        console.log(warn(`Network problem: ${shortError(error)}`));
        if (failures >= 5) {
          console.log(err("The RPC keeps failing. Stopping; try again later or set B20MINER_RPC_URL."));
          break;
        }
        if (state.stopRequested) break;
        await sleep(3000);
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    state.search?.stop();
  }

  let finalEth: bigint | null = null;
  try {
    finalEth = await withRetry(() => client.getBalance({ address: account.address }), 3);
  } catch {
    // shown as unavailable
  }
  console.log(`\n  ${bold("Session")}  ${accepted} proof${accepted === 1 ? "" : "s"}  ${rose(`+${amount(sessionReward, sym, 1)}`)}  ${muted(`spent ${formatEther(sessionSpent)} ETH`)}`);
  console.log(`  ${bold("Mined")}    ${lastMined !== null ? bold(amount(lastMined, sym)) : "—"} ${muted(`in all for ${to ? owner : "this wallet"}`)}`);
  console.log(`  ${bold("Wallet")}   ${account.address}  ${finalEth !== null ? `${formatEther(finalEth)} ETH` : muted("ETH balance unavailable")}\n`);
  if (state.stopRequested) console.log(`  ${amber("Stopped.")} Start again with: ${bold("b20miner start")}\n`);
  else {
    const end = seen();
    if (accepted > 0 && end) console.log(`  ${muted(deliveryNext(end.c, { ...end.p, mined: lastMined ?? end.p.mined }, to))}\n`);
  }
}
