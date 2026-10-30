import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePacked, type Address, type Hex } from "viem";
import { computePowHash } from "../src/vendor/b20Pow.ts";
import { jobPrefixHex, nativeHasherAvailable, startSearch, verifyProof, type PowJob } from "../src/hasher.ts";

const HASHER = fileURLToPath(new URL("../native/b20miner-hasher", import.meta.url));
const vectors = JSON.parse(readFileSync(new URL("./vectors/pow-v1.json", import.meta.url), "utf8")) as {
  vectors: Array<{ name: string; chainId: string; miningContract: Address; snapshotWallet: Address; miningWallet: Address; challenge: Hex; nonce: string; expectedHash: Hex }>;
};

test("native hasher is built", () => {
  assert.ok(nativeHasherAvailable(), "run `npm run build:hasher`");
});

test("native hasher reproduces every pow-reference vector with a 64-bit nonce", () => {
  let checked = 0;
  for (const v of vectors.vectors) {
    const nonce = BigInt(v.nonce);
    if (nonce >= 2n ** 63n) continue; // the native loop only walks 64-bit nonces
    // The native preimage uses the same encodePacked prefix as pow-reference, so any wallet pair works.
    const prefix = encodePacked(
      ["string", "uint256", "address", "address", "address", "bytes32"],
      ["B20_POW_V1", BigInt(v.chainId), v.miningContract, v.snapshotWallet, v.miningWallet, v.challenge],
    ).slice(2);
    const out = execFileSync(HASHER, [prefix, v.expectedHash.slice(2), nonce.toString(), "1"], { encoding: "utf8" });
    const found = out.split("\n").find((l) => l.startsWith("F "));
    assert.ok(found, `${v.name}: expected a hit at the vector nonce`);
    const [, n, h] = found!.split(" ");
    assert.equal(n, v.nonce, v.name);
    assert.equal(h, v.expectedHash, `${v.name}: native hash matches pow-reference`);
    checked++;
  }
  assert.ok(checked >= 1, `checked ${checked} vectors`);
});

test("native hash equals computePowHash for many consecutive nonces", () => {
  const job: PowJob = {
    chainId: 84532n,
    contract: "0x1D0E1c0f286D554C0aEc44659f875e4d00DfDDe8",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    miner: "0xAF90D1be10353B13a3e81F0783DEc8D448310431",
    challenge: "0x09ed7e0000000000000000000000000000000000000000000000000000d53d00",
    target: 2n ** 256n - 1n,
  };
  for (const start of [0n, 1n, 255n, 65_535n, 2n ** 32n + 7n, 2n ** 56n + 3n]) {
    const out = execFileSync(HASHER, [jobPrefixHex(job), "f".repeat(64), start.toString(), "1"], { encoding: "utf8" });
    const [, , h] = out.split("\n").find((l) => l.startsWith("F "))!.split(" ");
    const expected = computePowHash({ chainId: job.chainId, miningContract: job.contract, snapshotWallet: job.owner, miningWallet: job.miner, challenge: job.challenge, nonce: start });
    assert.equal(h, expected, `nonce ${start}`);
  }
});

test("pool search finds a proof that pow-reference accepts (16-bit target)", async () => {
  const job: PowJob = {
    chainId: 84532n,
    contract: "0x7BECD475e8E70102E07b2e9F0e7fa06eD20E349D",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    miner: "0xAF90D1be10353B13a3e81F0783DEc8D448310431",
    challenge: "0x1111111111111111111111111111111111111111111111111111111111111111",
    target: (2n ** 256n - 1n) >> 16n,
  };
  const search = startSearch(job, 2, () => {}, 12345n);
  const proof = await search.result;
  assert.ok(proof);
  assert.equal(verifyProof(job, proof!.nonce), proof!.hash);
  assert.ok(BigInt(proof!.hash) <= job.target);
});

test("the owner and the mining wallet sit in their own preimage slots", () => {
  const job: PowJob = {
    chainId: 84532n,
    contract: "0xd86db2BE5D319654A4EFD9d62Be6602902d3aB2c",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    miner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    challenge: "0x2222222222222222222222222222222222222222222222222222222222222222",
    target: 2n ** 256n - 1n,
  };
  const swapped: PowJob = { ...job, owner: job.miner, miner: job.owner };
  assert.notEqual(jobPrefixHex(job), jobPrefixHex(swapped));
  const expected = computePowHash({ chainId: job.chainId, miningContract: job.contract, snapshotWallet: job.owner, miningWallet: job.miner, challenge: job.challenge, nonce: 42n });
  assert.equal(verifyProof(job, 42n), expected);
  const out = execFileSync(HASHER, [jobPrefixHex(job), "f".repeat(64), "42", "1"], { encoding: "utf8" });
  assert.equal(out.split("\n").find((l) => l.startsWith("F "))!.split(" ")[2], expected, "native hash uses owner then mining wallet");
});
