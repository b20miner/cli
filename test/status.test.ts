import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE, FINALIZED, type Campaign, type Position } from "../src/chain.ts";
import { deliveryNext, formatDuration, leftToMine, proofsLeft, readiness } from "../src/status.ts";

const E = 10n ** 18n;
const REWARD = 10_000n * E;

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    token: "0xB20000000000000000000076d1c18713D30f5a64",
    campaign: "0x55D5936B2B493C1110B62D9f36AAddc5B6648834",
    name: "test1",
    symbol: "TEST1",
    opened: true,
    start: 900n,
    end: 2_000n,
    status: ACTIVE,
    minedTotal: 0n,
    miningReserve: 600_000_000n * E,
    capTokens: 5_000_000n * E,
    rewardPerProof: REWARD,
    proofFee: 100_000_000_000_000n,
    powTarget: 1n << 230n,
    hourlySchedule: false,
    nextReleaseAt: 0n,
    claimVestingDays: 0,
    distributionDone: false,
    claimDeadline: 0n,
    now: 1_000n,
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    mined: 0n,
    proofs: 0n,
    claimable: 0n,
    claimed: 0n,
    balance: 0n,
    quote: { reward: REWARD, fee: 100_000_000_000_000n },
    ...over,
  };
}

test("an open campaign with reserve and quota left is ready", () => {
  assert.deepEqual(readiness(campaign(), position()), { ready: true });
});

test("each blocker stops mining and names what happens next", () => {
  const cases: Array<[Campaign, Position, string]> = [
    [campaign({ status: FINALIZED }), position(), "finalized"],
    [campaign({ opened: false }), position(), "not-open"],
    [campaign({ now: 800n }), position(), "not-started"],
    [campaign({ now: 2_000n }), position(), "closed"],
    [campaign({ minedTotal: 600_000_000n * E }), position(), "sold-out"],
    [campaign(), position({ mined: 5_000_000n * E }), "quota-done"],
    [campaign({ hourlySchedule: true, nextReleaseAt: 1_600n }), position({ quote: { reward: 0n, fee: 0n } }), "hourly"],
  ];
  for (const [c, p, blocker] of cases) {
    const r = readiness(c, p);
    assert.equal(r.ready, false, blocker);
    if (!r.ready) {
      assert.equal(r.blocker, blocker);
      assert.ok(r.next.length > 0, `${blocker} names a next step`);
    }
  }
});

test("a launched token beats every other blocker", () => {
  const r = readiness(campaign({ status: FINALIZED, opened: false, now: 5_000n }), position());
  assert.equal(!r.ready && r.blocker, "finalized");
});

test("the hourly wait says when the next share comes", () => {
  const r = readiness(campaign({ hourlySchedule: true, nextReleaseAt: 1_600n }), position({ quote: { reward: 0n, fee: 0n } }));
  assert.ok(!r.ready && r.next.includes("10m"));
});

test("leftToMine is the smaller of the wallet's quota and the reserve left", () => {
  assert.equal(leftToMine(campaign(), position({ mined: 4_000_000n * E })), 1_000_000n * E);
  assert.equal(leftToMine(campaign({ minedTotal: 599_990_000n * E }), position()), 10_000n * E);
  assert.equal(leftToMine(campaign({ minedTotal: 700_000_000n * E }), position()), 0n);
});

test("deliveryNext follows the token from mining to the wallet", () => {
  assert.match(deliveryNext(campaign(), position()), /Nothing of it was mined/);
  assert.match(deliveryNext(campaign(), position({ mined: REWARD })), /when the pool opens/);
  assert.match(deliveryNext(campaign({ status: FINALIZED }), position({ mined: REWARD })), /sending every miner/);
  assert.match(deliveryNext(campaign({ status: FINALIZED, distributionDone: true }), position({ mined: REWARD, claimable: 1n })), /b20miner claim/);
  assert.match(deliveryNext(campaign({ status: FINALIZED, distributionDone: true, claimVestingDays: 30 }), position({ mined: REWARD, claimed: REWARD / 4n })), /vests/);
  assert.match(deliveryNext(campaign({ status: FINALIZED, distributionDone: true }), position({ mined: REWARD, claimed: REWARD })), /in this wallet/);
});

test("proofsLeft rounds a partial last proof up", () => {
  assert.equal(proofsLeft(50_000n * E, REWARD), 5n);
  assert.equal(proofsLeft(REWARD + 1n, REWARD), 2n);
  assert.equal(proofsLeft(0n, REWARD), 0n);
  assert.equal(proofsLeft(5n, 0n), 0n);
});

test("formatDuration", () => {
  assert.equal(formatDuration(30n), "30s");
  assert.equal(formatDuration(45n * 60n), "45m");
  assert.equal(formatDuration(2n * 3600n + 15n * 60n), "2h 15m");
  assert.equal(formatDuration(3n * 86_400n + 4n * 3600n), "3d 4h");
  assert.equal(formatDuration(-5n), "0s");
});

test("with the user's own wallet as the rewards wallet, every message names it and claims point to the Launchpad", () => {
  const to = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
  assert.match(deliveryNext(campaign(), position({ mined: REWARD }), to), /your wallet 0x3C44…93BC when the pool opens/);
  const claim = deliveryNext(campaign({ status: FINALIZED, distributionDone: true }), position({ mined: REWARD, claimable: 1n }), to);
  assert.match(claim, /launch\.b20miner\.xyz/);
  assert.doesNotMatch(claim, /b20miner claim/, "the CLI cannot claim for a wallet it has no key for");
  const done = readiness(campaign(), position({ mined: 5_000_000n * E }), to);
  assert.ok(!done.ready && /Your wallet 0x3C44…93BC has mined its full/.test(done.message));
});
