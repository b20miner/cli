import { parseEther } from "viem";

/**
 * Per-proof cost math, exact bigint (never floats):
 * - `msg.value` is the campaign's full-proof fee (`proofFee`); the campaign
 *   keeps only the fee for the reward it credits (smaller on a wallet's
 *   last, quota- or reserve-capped proof) and refunds the rest in the same
 *   transaction;
 * - the gas limit gets 20% headroom;
 * - the cost cap is compared against the worst case: buffered gas at the
 *   max fee per gas, plus the quoted mining fee.
 */

/** Default --max-cost: 0.0002 ETH per proof, the 0.0001 ETH Launchpad proof fee plus ample gas. */
export const DEFAULT_MAX_COST_WEI = 200_000_000_000_000n;

export function proofSendValue(quotedFee: bigint, proofFee: bigint): bigint {
  return quotedFee > proofFee ? quotedFee : proofFee;
}

export function bufferedGasLimit(estimatedGas: bigint): bigint {
  return (estimatedGas * 120n + 99n) / 100n;
}

/** The most one proof can cost: the gas worst case plus the whole `msg.value` signed (not the quote). */
export function maxProofCost(gasLimit: bigint, maxFeePerGas: bigint, sendValue: bigint): bigint {
  return gasLimit * maxFeePerGas + sendValue;
}

/**
 * Every Launchpad campaign charges the factory's fixed proof fee
 * (`PROOF_FEE_WEI`, pinned in this build), and a proof's fee is never more.
 * An RPC answer above it is refused before anything is signed (security
 * review run-2: the value came from the RPC alone). Null when fine.
 */
export function proofValueProblem(sendValue: bigint, campaignProofFee: bigint, pinnedProofFee: bigint): string | null {
  if (campaignProofFee !== pinnedProofFee || sendValue > pinnedProofFee)
    return "The RPC reports a proof fee that this Launchpad never charges. Nothing was sent; check B20MINER_RPC_URL or try again.";
  return null;
}

/** What the wallet must hold to send: the gas worst case plus the full `msg.value`. */
export function requiredBalance(gasLimit: bigint, maxFeePerGas: bigint, sendValue: bigint): bigint {
  return gasLimit * maxFeePerGas + sendValue;
}

/** Parses a plain decimal ETH amount ("0.0001") to wei; rejects zero, signs and exponents. */
export function parseEthAmount(input: string, label: string): bigint {
  const value = input.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error(`${label} needs a plain ETH amount, for example 0.0002.`);
  const wei = parseEther(value);
  if (wei <= 0n) throw new Error(`${label} must be greater than zero.`);
  return wei;
}
