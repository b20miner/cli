/**
 * B20MINER PoW V1 hash/validity reference — Solidity <-> TypeScript
 * compatibility layer only.
 *
 * This module intentionally does NOT include a nonce search loop, a Web
 * Worker, WASM, or any UI. It exists only to prove that this exact packed
 * encoding, hashed with Ethereum Keccak-256 (not NIST SHA3-256), produces
 * the same result as `B20PoW.sol`'s `computeHash`/`isValid`.
 *
 * Browser-compatible: no Node-only `crypto`, filesystem, or `process`
 * dependency. `chainId`, `nonce` and `target` are all `bigint` — a
 * JavaScript `number` cannot losslessly carry a 256-bit value.
 */
import { bytesToHex, encodePacked, hexToBytes, isAddress, isHex, keccak256, type Address, type Hex } from "viem";

export const B20_POW_DOMAIN = "B20_POW_V1" as const;

export interface B20PowInputs {
  /** EVM chain id the mining contract is deployed on (bigint, not number). */
  chainId: bigint;
  /** The B20Mining contract's own address. */
  miningContract: Address;
  /** The owner/snapshot wallet the proof is bound to. */
  snapshotWallet: Address;
  /** The mining wallet submitting the proof (msg.sender on-chain). */
  miningWallet: Address;
  /** Current challenge, a 32-byte value. */
  challenge: Hex;
  /** Nonce found by the miner (bigint, not number). */
  nonce: bigint;
}

function assertBigInt(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be a bigint, got ${typeof value}`);
  }
}

function assertAddress(value: unknown, label: string): asserts value is Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new TypeError(`${label} must be a valid 20-byte 0x-prefixed address, got: ${String(value)}`);
  }
}

function assertBytes32(value: unknown, label: string): asserts value is Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) {
    throw new TypeError(`${label} must be a 32-byte (66-char) 0x-prefixed hex value, got: ${String(value)}`);
  }
}

function validateInputs(inputs: B20PowInputs): void {
  assertBigInt(inputs.chainId, "chainId");
  assertAddress(inputs.miningContract, "miningContract");
  assertAddress(inputs.snapshotWallet, "snapshotWallet");
  assertAddress(inputs.miningWallet, "miningWallet");
  assertBytes32(inputs.challenge, "challenge");
  assertBigInt(inputs.nonce, "nonce");
}

/**
 * keccak256(encodePacked(
 *   ["string","uint256","address","address","address","bytes32","uint256"],
 *   ["B20_POW_V1", chainId, miningContract, snapshotWallet, miningWallet, challenge, nonce],
 * ))
 *
 * Field types and order are fixed and must match `B20PoW.sol` exactly.
 * Uses Ethereum Keccak-256 (viem's `keccak256`), not NIST SHA3-256.
 */
export function computePowHash(inputs: B20PowInputs): Hex {
  validateInputs(inputs);
  return keccak256(
    encodePacked(
      ["string", "uint256", "address", "address", "address", "bytes32", "uint256"],
      [
        B20_POW_DOMAIN,
        inputs.chainId,
        inputs.miningContract,
        inputs.snapshotWallet,
        inputs.miningWallet,
        inputs.challenge,
        inputs.nonce,
      ],
    ),
  );
}

/** True iff BigInt(computePowHash(inputs)) <= target. */
export function isValidPow(inputs: B20PowInputs, target: bigint): boolean {
  assertBigInt(target, "target");
  return BigInt(computePowHash(inputs)) <= target;
}

const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

/** Everything in `B20PowInputs` except the nonce — fixed for one search job. */
export type B20PowJob = Omit<B20PowInputs, "nonce">;

/** A per-job hasher for nonce search loops (see `createPowJobHasher`). */
export interface PowJobHasher {
  /** Same result as `computePowHash({ ...job, nonce })`. */
  hash(nonce: bigint): Hex;
  /** Same result as `isValidPow({ ...job, nonce }, target)`. */
  isValid(nonce: bigint, target: bigint): boolean;
}

/** 32-byte big-endian encoding of a uint256. */
function uint256ToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setBigUint64(i * 8, (value >> BigInt(192 - i * 64)) & UINT64_MAX);
  return bytes;
}

/** Big-endian `a <= b` for two equal-length byte arrays. */
function bytesLte(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

/**
 * A fast hasher for one fixed search job. The packed preimage is
 * `prefix || uint256(nonce)`, where the prefix (domain, chainId, contract,
 * both wallets, challenge) does not depend on the nonce. So it is encoded
 * once; each call only writes the 32-byte nonce into a reused buffer and
 * hashes it, and `isValid` compares the hash bytes to the target without
 * converting to a bigint. The encoding is the same `encodePacked` call as
 * `computePowHash`, so this is not a second definition of the hash: the
 * tests assert both produce identical bytes. `computePowHash` stays the
 * canonical definition; use this only inside search loops.
 */
export function createPowJobHasher(job: B20PowJob): PowJobHasher {
  validateInputs({ ...job, nonce: 0n });
  const prefix = hexToBytes(
    encodePacked(
      ["string", "uint256", "address", "address", "address", "bytes32"],
      [B20_POW_DOMAIN, job.chainId, job.miningContract, job.snapshotWallet, job.miningWallet, job.challenge],
    ),
  );
  const buffer = new Uint8Array(prefix.length + 32);
  buffer.set(prefix);
  const nonceView = new DataView(buffer.buffer, prefix.length, 32);
  let targetCache: { target: bigint; bytes: Uint8Array } | null = null;

  function writeNonce(nonce: bigint): void {
    assertBigInt(nonce, "nonce");
    if (nonce < 0n || nonce > UINT256_MAX) throw new RangeError("nonce must be a uint256");
    if (nonce <= UINT64_MAX) {
      // Search loops start at a random 64-bit nonce, so this is the hot path.
      nonceView.setBigUint64(0, 0n);
      nonceView.setBigUint64(8, 0n);
      nonceView.setBigUint64(16, 0n);
      nonceView.setBigUint64(24, nonce);
    } else {
      buffer.set(uint256ToBytes(nonce), prefix.length);
    }
  }

  function hashBytes(nonce: bigint): Uint8Array {
    writeNonce(nonce);
    return keccak256(buffer, "bytes");
  }

  return {
    hash(nonce) {
      return bytesToHex(hashBytes(nonce));
    },
    isValid(nonce, target) {
      assertBigInt(target, "target");
      if (target < 0n) return false;
      if (target >= UINT256_MAX) return true;
      if (targetCache === null || targetCache.target !== target) {
        targetCache = { target, bytes: uint256ToBytes(target) };
      }
      return bytesLte(hashBytes(nonce), targetCache.bytes);
    },
  };
}
