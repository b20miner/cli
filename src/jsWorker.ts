import { parentPort, workerData } from "node:worker_threads";
import { createPowJobHasher } from "./vendor/b20Pow.ts";
import type { Address, Hex } from "viem";

/** Fallback search loop when the native hasher is not built. */
const data = workerData as { chainId: string; contract: Address; owner: Address; miner: Address; challenge: Hex; target: string; start: string };
const target = BigInt(data.target);
const hasher = createPowJobHasher({
  chainId: BigInt(data.chainId),
  miningContract: data.contract,
  snapshotWallet: data.owner,
  miningWallet: data.miner,
  challenge: data.challenge,
});

let nonce = BigInt(data.start);
let count = 0;
for (;;) {
  for (let i = 0; i < 4096; i++) {
    count++;
    if (hasher.isValid(nonce, target)) {
      parentPort!.postMessage({ kind: "count", n: count });
      parentPort!.postMessage({ kind: "found", nonce: nonce.toString() });
    }
    nonce++;
  }
  parentPort!.postMessage({ kind: "count", n: count });
}
