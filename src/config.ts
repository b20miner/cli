import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { DEPLOYMENT } from "./deployment.ts";

/**
 * CLI v0.3 (28 Oct 2026) mines B20MINER Launchpad tokens on Base Sepolia:
 * the mining campaigns of the Launchpad factory embedded at build time
 * from the repository's deployment record (scripts/sync.mjs). The wallet
 * kept on this computer both sends the proofs and earns the tokens: it is
 * the campaign "owner" and the "miner" at once, so nothing is signed in a
 * browser. The token list comes from the B20MINER indexer, with the chain
 * itself as the fallback. B20MINER_RPC_URL overrides the public RPC (for
 * example a local fork), B20MINER_INDEXER_URL the indexer (an empty value
 * turns it off and lists tokens from the chain).
 */

export const VERSION = "0.3.3";

/** The Launchpad web app, for the token pages. */
export const APP_URL = "https://launch.b20miner.xyz";

export interface NetworkConfig {
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly indexerUrl: string | null;
  readonly explorerTx: (hash: string) => string;
  readonly explorerAddress: (address: string) => string;
  readonly launchpad: Address;
  readonly deployBlock: bigint;
}

export function networkConfig(): NetworkConfig {
  const indexer = process.env.B20MINER_INDEXER_URL ?? "https://sepolia-api.b20miner.xyz";
  return {
    name: "Base Sepolia",
    chainId: DEPLOYMENT.chainId,
    rpcUrl: process.env.B20MINER_RPC_URL ?? "https://sepolia.base.org",
    indexerUrl: indexer.trim() === "" ? null : indexer.replace(/\/+$/, ""),
    explorerTx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    explorerAddress: (address) => `https://sepolia.basescan.org/address/${address}`,
    launchpad: getAddress(DEPLOYMENT.launchpadFactory),
    deployBlock: BigInt(DEPLOYMENT.deployBlock),
  };
}

/** ~/.b20miner (0700). B20MINER_HOME overrides it, e.g. for tests. */
export function homeDir(): string {
  return process.env.B20MINER_HOME ?? join(homedir(), ".b20miner");
}

export function walletPath(): string {
  return join(homeDir(), "wallet.json");
}

function settingsPath(): string {
  return join(homeDir(), "config.json");
}

interface Settings {
  /** The token `b20miner start` mines when none is named (the last one started). */
  readonly token?: string;
  /** Every token this wallet started mining, newest first: what `balance` shows and symbols resolve to first. */
  readonly tokens?: readonly string[];
  /**
   * Where mined tokens go: "self" (this CLI's wallet) or the user's own
   * wallet address (only the address is kept; the CLI never has its key).
   * Missing until the first `start` asks.
   */
  readonly rewardsTo?: string;
}

const MAX_KNOWN = 100;

function readSettings(): Settings {
  try {
    return existsSync(settingsPath()) ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings) : {};
  } catch {
    return {};
  }
}

export function savedToken(): Address | null {
  const token = readSettings().token;
  return token && isAddress(token) ? getAddress(token) : null;
}

export function knownTokens(): Address[] {
  const list = readSettings().tokens;
  const out = Array.isArray(list) ? list.filter((t): t is string => typeof t === "string" && isAddress(t, { strict: false })).map((t) => getAddress(t)) : [];
  const last = savedToken();
  return last && !out.includes(last) ? [last, ...out] : out;
}

/** Remembers `token` as the last one mined and adds it to the known tokens. */
export function saveToken(token: Address): void {
  const t = getAddress(token);
  const tokens = [t, ...knownTokens().filter((k) => k !== t)].slice(0, MAX_KNOWN);
  writeSettings({ ...readSettings(), token: t, tokens });
}

function writeSettings(settings: Settings): void {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${settingsPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, settingsPath());
}

/** The rewards wallet chosen so far: an address, "self", or null when never chosen. */
export function rewardsSetting(): Address | "self" | null {
  const v = readSettings().rewardsTo;
  if (v === "self") return "self";
  return typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

export function saveRewardsTo(to: Address | "self"): void {
  writeSettings({ ...readSettings(), rewardsTo: to === "self" ? "self" : getAddress(to) });
}

/** Parses an address typed by the user; checksums it. */
export function parseAddress(input: string): Address {
  const value = input.trim();
  if (!isAddress(value, { strict: false })) throw new Error(`"${input}" is not an address (0x followed by 40 hex characters).`);
  return getAddress(value);
}

/** Shows an RPC URL without any path or query that may hold an API key. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 || u.search ? `${u.protocol}//${u.host}/…` : `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid URL)";
  }
}
