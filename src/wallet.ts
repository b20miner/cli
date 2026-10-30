import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";
import { walletPath } from "./config.ts";

/**
 * The CLI's mining wallet: one secp256k1 key, stored encrypted in
 * ~/.b20miner/wallet.json (file 0600, folder 0700) until the user deletes
 * it. scrypt (N=2^17, r=8, p=1) derives an AES-256-GCM key from the
 * password; the address is stored in the clear so `balance` works
 * without a password. The raw key exists in memory only while a command
 * that needs it runs.
 */

export const MIN_PASSWORD_LENGTH = 8;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 } as const;

interface WalletFile {
  readonly version: 1;
  readonly address: Address;
  readonly createdAt: string;
  readonly kdf: { readonly name: "scrypt"; readonly N: number; readonly r: number; readonly p: number; readonly salt: string };
  readonly cipher: { readonly name: "aes-256-gcm"; readonly iv: string; readonly tag: string; readonly data: string };
}

export class WalletError extends Error {}

function deriveKey(password: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password.normalize("NFKC"), salt, SCRYPT.dkLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 });
}

export function walletExists(): boolean {
  return existsSync(walletPath());
}

function readWalletFile(): WalletFile {
  if (!walletExists()) throw new WalletError("No mining wallet yet. Create one with: b20miner wallet create");
  const file = JSON.parse(readFileSync(walletPath(), "utf8")) as WalletFile;
  if (file.version !== 1 || file.kdf?.name !== "scrypt" || file.cipher?.name !== "aes-256-gcm") throw new WalletError("Unsupported wallet file format.");
  return file;
}

export function walletAddress(): Address {
  return getAddress(readWalletFile().address);
}

/** Generates a key, saves it encrypted, and returns it once for display. */
export function createWallet(password: string): { address: Address; privateKey: Hex } {
  if (walletExists()) throw new WalletError("A mining wallet already exists. Delete it first with: b20miner wallet delete");
  if (password.length < MIN_PASSWORD_LENGTH) throw new WalletError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(address.toLowerCase()));
  const data = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  const file: WalletFile = {
    version: 1,
    address,
    createdAt: new Date().toISOString(),
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") },
  };

  const path = walletPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);

  // Prove the file decrypts before showing the key.
  const check = unlockWallet(password);
  if (check.address !== address) throw new WalletError("Wallet self-check failed; nothing was created.");
  return { address, privateKey };
}

function decrypt(password: string): { address: Address; privateKey: Hex } {
  const file = readWalletFile();
  const key = deriveKey(password, Buffer.from(file.kdf.salt, "hex"), file.kdf);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "hex"));
    decipher.setAAD(Buffer.from(file.address.toLowerCase()));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, "hex"));
    const raw = Buffer.concat([decipher.update(Buffer.from(file.cipher.data, "hex")), decipher.final()]);
    const privateKey = `0x${raw.toString("hex")}` as Hex;
    raw.fill(0);
    if (privateKeyToAccount(privateKey).address !== getAddress(file.address)) throw new Error("mismatch");
    return { address: getAddress(file.address), privateKey };
  } catch {
    throw new WalletError("Wrong password.");
  }
}

export function unlockWallet(password: string): PrivateKeyAccount {
  return privateKeyToAccount(decrypt(password).privateKey);
}

/** For `wallet key`: shows the key again after the password. */
export function revealPrivateKey(password: string): Hex {
  return decrypt(password).privateKey;
}

export function deleteWallet(): void {
  rmSync(walletPath(), { force: true });
}
