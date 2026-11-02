import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_COST_WEI, bufferedGasLimit, maxProofCost, parseEthAmount, proofSendValue, proofValueProblem, requiredBalance } from "../src/costs.ts";

const FEE = 100_000_000_000_000n; // TEST1: 0.0001 ETH per proof

test("the send value is the full-proof fee, even when the last proof's quote is smaller", () => {
  assert.equal(proofSendValue(FEE, FEE), FEE);
  assert.equal(proofSendValue(1_000n, FEE), FEE, "excess is refunded by the contract");
});

test("gas gets 20% headroom, rounded up", () => {
  assert.equal(bufferedGasLimit(100_000n), 120_000n);
  assert.equal(bufferedGasLimit(100_001n), 120_002n);
});

test("worst-case cost and required balance", () => {
  const gas = 180_000n;
  const maxFee = 2_000_000n; // 0.002 gwei
  assert.equal(maxProofCost(gas, maxFee, FEE), gas * maxFee + FEE);
  assert.equal(requiredBalance(gas, maxFee, FEE), gas * maxFee + FEE);
  assert.ok(maxProofCost(gas, maxFee, FEE) <= DEFAULT_MAX_COST_WEI, "a normal Base proof fits the default cap");
  assert.ok(maxProofCost(gas, 1_000_000_000n, FEE) > DEFAULT_MAX_COST_WEI, "1 gwei gas is held back by the default cap");
});

test("parseEthAmount accepts plain decimals only", () => {
  assert.equal(parseEthAmount("0.0002", "--max-cost"), 200_000_000_000_000n);
  assert.equal(parseEthAmount(" 1 ", "--max-cost"), 10n ** 18n);
  for (const bad of ["", "0", "0.0", "-1", "1e-4", "abc", "0.0000000000000000001"]) {
    assert.throws(() => parseEthAmount(bad, "--max-cost"), Error, bad);
  }
});

test("the proof value is the factory's pinned fee or less; anything else from the RPC is refused (security review run-2)", () => {
  assert.equal(proofValueProblem(FEE, FEE, FEE), null);
  assert.equal(proofValueProblem(FEE / 2n, FEE, FEE), null, "a smaller last-proof quote is fine");
  assert.match(proofValueProblem(FEE * 1000n, FEE * 1000n, FEE) ?? "", /never charges/);
  assert.match(proofValueProblem(FEE, FEE * 2n, FEE) ?? "", /never charges/);
  // The cost cap counts the whole value sent, not the quote.
  assert.equal(maxProofCost(100n, 1n, proofSendValue(1n, FEE)), 100n + FEE);
});
