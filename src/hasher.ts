import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { encodePacked, type Address, type Hex } from "viem";
import { computePowHash } from "./vendor/b20Pow.ts";
import { VERSION, homeDir } from "./config.ts";

/**
 * Proof search. Each worker scans its own 2^48-nonce slice (same stride as
 * the web app's worker pool), so two workers never try the same nonce.
 * The native binary (native/hasher.c) does one Keccak-f per nonce; when it
 * is missing the built-in JS hasher runs instead, much slower.
 * Every found nonce is re-verified with pow-reference's `computePowHash`
 * before it is returned: there is exactly one hash definition.
 */

export const WORKER_NONCE_STRIDE = 2n ** 48n;
const CHUNK = 1n << 40n;

export interface PowJob {
  readonly chainId: bigint;
  readonly contract: Address;
  /** The owner wallet the proof is for (the hash's snapshot wallet). */
  readonly owner: Address;
  /** The mining wallet that sends the proof (msg.sender on-chain). */
  readonly miner: Address;
  readonly challenge: Hex;
  readonly target: bigint;
}

export interface FoundProof {
  readonly nonce: bigint;
  readonly hash: Hex;
  readonly hashesTried: number;
  readonly seconds: number;
}

export type Progress = (hashesTried: number, hashRate: number) => void;

const EXE = process.platform === "win32" ? ".exe" : "";
const NATIVE_DIR = fileURLToPath(new URL("../native/", import.meta.url));

export type HasherKind = "local build" | "built on this machine" | "built-in (slower)";
let resolved: { path: string | null; kind: HasherKind } | null = null;

/**
 * Where the native hasher comes from, in order:
 * 1. a binary built in the repository (`npm run build:hasher`);
 * 2. a one-time build of the bundled hasher.c with the system C compiler,
 *    cached in ~/.b20miner/bin;
 * 3. none: the slower built-in JS hasher.
 * The package ships no binaries: what runs is built here, from the source in
 * the package.
 */
export function resolveHasher(): { path: string | null; kind: HasherKind } {
  if (resolved) return resolved;
  // B20MINER_HASHER=js forces the built-in hasher (used to test the fallback).
  if (process.env.B20MINER_HASHER === "js") return (resolved = { path: null, kind: "built-in (slower)" });
  const local = join(NATIVE_DIR, `b20miner-hasher${EXE}`);
  const cached = join(homeDir(), "bin", `b20miner-hasher-${VERSION}-${process.platform}-${process.arch}${EXE}`);
  if (existsSync(local)) return (resolved = { path: local, kind: "local build" });
  if (existsSync(cached)) return (resolved = { path: cached, kind: "built on this machine" });
  const source = join(NATIVE_DIR, "hasher.c");
  if (existsSync(source) && compilerInstalled()) {
    mkdirSync(join(homeDir(), "bin"), { recursive: true, mode: 0o700 });
    for (const cc of ["cc", "gcc", "clang"]) {
      const out = spawnSync(cc, ["-O3", "-std=c11", "-o", cached, source], { stdio: "ignore" });
      if (out.status === 0 && existsSync(cached)) {
        chmodSync(cached, 0o755);
        return (resolved = { path: cached, kind: "built on this machine" });
      }
    }
  }
  return (resolved = { path: null, kind: "built-in (slower)" });
}

/**
 * On macOS, /usr/bin/cc is a stub until the Command Line Tools are
 * installed, and calling it opens Apple's install dialog. Ask xcode-select
 * first so the CLI never opens a dialog by itself.
 */
function compilerInstalled(): boolean {
  if (process.platform !== "darwin") return true;
  return spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status === 0;
}

/** How to get the native hasher on this system, or null when none is needed. */
export function hasherHint(): string | null {
  if (resolveHasher().path) return null;
  return process.platform === "darwin"
    ? "For the fast native hasher, install Apple's command line tools once: xcode-select --install"
    : "For the fast native hasher, install a C compiler (cc, gcc or clang).";
}

export function nativeHasherAvailable(): boolean {
  return resolveHasher().path !== null;
}

export function defaultWorkerCount(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

export function maxWorkerCount(): number {
  return availableParallelism();
}

/** The 134 constant bytes before the nonce, as hex (no 0x). */
export function jobPrefixHex(job: PowJob): string {
  const packed = encodePacked(
    ["string", "uint256", "address", "address", "address", "bytes32"],
    ["B20_POW_V1", job.chainId, job.contract, job.owner, job.miner, job.challenge],
  );
  return packed.slice(2);
}

function targetHex(target: bigint): string {
  return target.toString(16).padStart(64, "0");
}

export function verifyProof(job: PowJob, nonce: bigint): Hex | null {
  const hash = computePowHash({
    chainId: job.chainId,
    miningContract: job.contract,
    snapshotWallet: job.owner,
    miningWallet: job.miner,
    challenge: job.challenge,
    nonce,
  });
  return BigInt(hash) <= job.target ? hash : null;
}

/** A running search that can be stopped at any time. */
export interface Search {
  readonly result: Promise<FoundProof | null>;
  stop(): void;
}

export function startSearch(job: PowJob, workers: number, onProgress: Progress, seed: bigint): Search {
  const started = performance.now();
  const counts = new Array<number>(workers).fill(0);
  const stops: Array<() => void> = [];
  let settled = false;
  let resolveResult!: (value: FoundProof | null) => void;
  const result = new Promise<FoundProof | null>((resolve) => (resolveResult = resolve));

  const total = () => counts.reduce((a, b) => a + b, 0);
  const finish = (value: FoundProof | null) => {
    if (settled) return;
    settled = true;
    for (const stop of stops) stop();
    resolveResult(value);
  };
  const report = () => {
    const seconds = (performance.now() - started) / 1000;
    onProgress(total(), seconds > 0 ? total() / seconds : 0);
  };
  const onFound = (finder: number, nonce: bigint) => {
    const hash = verifyProof(job, nonce);
    if (!hash) return; // never trust a worker: a bad claim is ignored
    // Workers report progress every ~250 ms, so a fast find leaves the others
    // unreported. They run at the same speed, so the finder's count is the
    // best estimate for each of them.
    const estimate = counts.reduce((sum, c) => sum + Math.max(c, counts[finder]!), 0);
    finish({ nonce, hash, hashesTried: estimate, seconds: (performance.now() - started) / 1000 });
  };

  const run = nativeHasherAvailable() ? runNative : runJs;
  for (let i = 0; i < workers; i++) {
    const sliceStart = (seed + BigInt(i) * WORKER_NONCE_STRIDE) % (2n ** 63n);
    stops.push(
      run(job, sliceStart, (n) => {
        counts[i] = n;
        report();
      }, (nonce) => onFound(i, nonce)),
    );
  }

  return { result, stop: () => finish(null) };
}

/** Native: consecutive chunks of CHUNK nonces inside this worker's slice. */
function runNative(job: PowJob, sliceStart: bigint, onCount: (n: number) => void, onFound: (nonce: bigint) => void): () => void {
  let stopped = false;
  let child: ChildProcess | null = null;
  let base = 0;
  let chunkStart = sliceStart;
  const prefix = jobPrefixHex(job);
  const target = targetHex(job.target);

  const launch = () => {
    if (stopped) return;
    const proc = spawn(resolveHasher().path!, [prefix, target, chunkStart.toString(), CHUNK.toString()], { stdio: ["ignore", "pipe", "inherit"] });
    child = proc;
    let buffer = "";
    let chunkCount = 0;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (data: string) => {
      buffer += data;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const [kind, a] = line.split(" ");
        if (kind === "P") {
          chunkCount = Number(a);
          onCount(base + chunkCount);
        } else if (kind === "F" && a) {
          onFound(BigInt(a));
        }
      }
    });
    proc.on("exit", () => {
      if (stopped) return;
      base += chunkCount;
      chunkStart += CHUNK;
      launch();
    });
  };
  launch();
  return () => {
    stopped = true;
    child?.kill();
  };
}

/** Fallback: a worker thread running pow-reference's hash in a loop. */
function runJs(job: PowJob, sliceStart: bigint, onCount: (n: number) => void, onFound: (nonce: bigint) => void): () => void {
  const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./jsWorker.ts" : "./jsWorker.js", import.meta.url), {
    workerData: { ...job, chainId: job.chainId.toString(), target: job.target.toString(), start: sliceStart.toString() },
  });
  worker.on("message", (msg: { kind: "count"; n: number } | { kind: "found"; nonce: string }) => {
    if (msg.kind === "count") onCount(msg.n);
    else onFound(BigInt(msg.nonce));
  });
  return () => void worker.terminate();
}
