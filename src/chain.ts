import { createPublicClient, defineChain, getAddress, http, isAddress, parseAbi, type Address, type Chain, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { NetworkConfig } from "./config.ts";

/** The Launchpad factory surface the CLI reads (contracts/src/launchpad/LaunchpadFactory.sol). */
export const LAUNCHPAD_ABI = parseAbi([
  "function campaignCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
  "function campaignOf(address token) view returns (address campaign, address pool, address creator, uint64 createdAt)",
]);

/** The MiningCampaign surface the CLI reads and calls (contracts/src/launchpad/MiningCampaign.sol). */
export const CAMPAIGN_ABI = parseAbi([
  "function submitProof(address owner, bytes32 expectedChallenge, uint256 nonce) payable",
  "function claim()",
  "function quoteProof(address owner) view returns (uint256 reward, uint256 fee)",
  "function challengeOf(address owner) view returns (bytes32)",
  "function token() view returns (address)",
  "function powTarget() view returns (uint256)",
  "function proofFee() view returns (uint256)",
  "function rewardPerProof() view returns (uint256)",
  "function miningReserve() view returns (uint256)",
  "function minedTotal() view returns (uint256)",
  "function start() view returns (uint64)",
  "function end() view returns (uint64)",
  "function opened() view returns (bool)",
  "function status() view returns (uint8)",
  "function capTokens() view returns (uint256)",
  "function hourlySchedule() view returns (bool)",
  "function nextReleaseAt() view returns (uint256)",
  "function claimVestingDays() view returns (uint8)",
  "function distributionDone() view returns (bool)",
  "function claimDeadline() view returns (uint256)",
  "function minedOf(address owner) view returns (uint256)",
  "function acceptedProofs(address owner) view returns (uint256)",
  "function claimable(address owner) view returns (uint256)",
  "function claimedOf(address owner) view returns (uint256)",
  "event ProofRewarded(address indexed owner, address indexed miner, uint256 reward, uint256 fee, uint256 minedOfOwner, uint256 minedTotal, bytes32 newChallenge)",
  "error NotStarted()",
  "error WindowClosed()",
  "error NotOpened()",
  "error ZeroOwner()",
  "error StaleChallenge(bytes32 expected, bytes32 current)",
  "error InvalidProof()",
  "error ReserveExhausted()",
  "error QuotaExhausted(address owner)",
  "error HourlyLimitReached(uint256 nextHourAt)",
  "error InsufficientFee(uint256 provided, uint256 required)",
  "error NotActive()",
  "error NotFinalized()",
  "error ClaimClosed()",
  "error NothingToClaim()",
  "error EthTransferFailed(address to, uint256 amount)",
]);

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** Multicall3: the same address on Base, Base Sepolia and every fork of them. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export function chainOf(config: NetworkConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

export function publicClient(config: NetworkConfig): PublicClient {
  return createPublicClient({ chain: chainOf(config), transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }) }) as PublicClient;
}

/**
 * Signs here and sends the raw transaction: chain id from this build's
 * config, nonce, gas and fees read one by one. Never `eth_fillTransaction`,
 * whose answer viem may keep (gas, fees, even the chain id it signs for)
 * over what was checked (security review run-2). Missing gas and fees are
 * estimated through `client`.
 */
export async function sendFromWallet(
  client: PublicClient,
  config: NetworkConfig,
  account: PrivateKeyAccount,
  tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
): Promise<Hex> {
  const fees = tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : await client.estimateFeesPerGas();
  const [nonce, gas] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    tx.gas ?? client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value }),
  ]);
  const serializedTransaction = await account.signTransaction({
    type: "eip1559",
    chainId: config.chainId,
    nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return client.sendRawTransaction({ serializedTransaction });
}

export class ChainError extends Error {}

/** Refuses to run against the wrong chain or a missing Launchpad factory. */
export async function checkNetwork(client: PublicClient, config: NetworkConfig): Promise<void> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    throw new ChainError(`The RPC endpoint is not reachable. Try again, or set B20MINER_RPC_URL to your own ${config.name} RPC.`);
  }
  if (chainId !== config.chainId) throw new ChainError(`The RPC is on chain ${chainId}, not ${config.name} (${config.chainId}). Mining will not start.`);
  const code = await client.getCode({ address: config.launchpad });
  if (!code || code === "0x") throw new ChainError(`No Launchpad factory at ${config.launchpad} on ${config.name}.`);
}

/** `MiningCampaign.Status`. */
export const ACTIVE = 0;
export const FINALIZED = 1;

/** One mining campaign as the chain says, and this wallet's place in it. */
export interface Campaign {
  readonly token: Address;
  readonly campaign: Address;
  readonly name: string;
  readonly symbol: string;
  readonly opened: boolean;
  readonly start: bigint;
  readonly end: bigint;
  readonly status: number;
  readonly minedTotal: bigint;
  readonly miningReserve: bigint;
  readonly capTokens: bigint;
  readonly rewardPerProof: bigint;
  readonly proofFee: bigint;
  readonly powTarget: bigint;
  readonly hourlySchedule: boolean;
  readonly nextReleaseAt: bigint;
  readonly claimVestingDays: number;
  readonly distributionDone: boolean;
  readonly claimDeadline: bigint;
  /** Chain time of the block the reads came from. */
  readonly now: bigint;
}

export interface Position {
  readonly wallet: Address;
  readonly mined: bigint;
  readonly proofs: bigint;
  readonly claimable: bigint;
  readonly claimed: bigint;
  /** Tokens of this campaign already in the wallet (delivered when the pool opened, or claimed). */
  readonly balance: bigint;
  /** What the next proof would earn and cost now; (0, 0) when it cannot earn anything. */
  readonly quote: { readonly reward: bigint; readonly fee: bigint };
}

const CAMPAIGN_VIEWS = [
  "opened",
  "start",
  "end",
  "status",
  "minedTotal",
  "miningReserve",
  "capTokens",
  "rewardPerProof",
  "proofFee",
  "powTarget",
  "hourlySchedule",
  "nextReleaseAt",
  "claimVestingDays",
  "distributionDone",
  "claimDeadline",
] as const;

/** Every figure of one campaign, and (with `wallet`) this wallet's position, from one block. */
export async function readCampaign(client: PublicClient, ref: { token: Address; campaign: Address }, wallet?: Address): Promise<{ c: Campaign; p: Position | null }> {
  const block = await client.getBlock();
  const at = { blockNumber: block.number } as const;
  const views = CAMPAIGN_VIEWS.map((functionName) => ({ address: ref.campaign, abi: CAMPAIGN_ABI, functionName }) as const);
  const meta = [
    { address: ref.token, abi: ERC20_ABI, functionName: "name" },
    { address: ref.token, abi: ERC20_ABI, functionName: "symbol" },
  ] as const;
  const mine = wallet
    ? ([
        { address: ref.campaign, abi: CAMPAIGN_ABI, functionName: "minedOf", args: [wallet] },
        { address: ref.campaign, abi: CAMPAIGN_ABI, functionName: "acceptedProofs", args: [wallet] },
        { address: ref.campaign, abi: CAMPAIGN_ABI, functionName: "claimable", args: [wallet] },
        { address: ref.campaign, abi: CAMPAIGN_ABI, functionName: "claimedOf", args: [wallet] },
        { address: ref.token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] },
        { address: ref.campaign, abi: CAMPAIGN_ABI, functionName: "quoteProof", args: [wallet] },
      ] as const)
    : [];
  const r = (await client.multicall({ contracts: [...views, ...meta, ...mine] as never, allowFailure: false, multicallAddress: MULTICALL3, ...at })) as unknown[];
  const v = (name: (typeof CAMPAIGN_VIEWS)[number]) => r[CAMPAIGN_VIEWS.indexOf(name)];
  const n = CAMPAIGN_VIEWS.length;
  const c: Campaign = {
    token: ref.token,
    campaign: ref.campaign,
    name: cleanText(r[n]),
    symbol: cleanText(r[n + 1], 16),
    opened: v("opened") as boolean,
    start: BigInt(v("start") as bigint),
    end: BigInt(v("end") as bigint),
    status: Number(v("status")),
    minedTotal: v("minedTotal") as bigint,
    miningReserve: v("miningReserve") as bigint,
    capTokens: v("capTokens") as bigint,
    rewardPerProof: v("rewardPerProof") as bigint,
    proofFee: v("proofFee") as bigint,
    powTarget: v("powTarget") as bigint,
    hourlySchedule: v("hourlySchedule") as boolean,
    nextReleaseAt: v("nextReleaseAt") as bigint,
    claimVestingDays: Number(v("claimVestingDays")),
    distributionDone: v("distributionDone") as boolean,
    claimDeadline: v("claimDeadline") as bigint,
    now: block.timestamp,
  };
  if (!wallet) return { c, p: null };
  const q = r[n + 7] as readonly [bigint, bigint];
  return {
    c,
    p: {
      wallet,
      mined: r[n + 2] as bigint,
      proofs: r[n + 3] as bigint,
      claimable: r[n + 4] as bigint,
      claimed: r[n + 5] as bigint,
      balance: r[n + 6] as bigint,
      quote: { reward: q[0], fee: q[1] },
    },
  };
}

export function readChallenge(client: PublicClient, campaign: Address, owner: Address): Promise<Hex> {
  return client.readContract({ address: campaign, abi: CAMPAIGN_ABI, functionName: "challengeOf", args: [owner] });
}

/**
 * Token names and symbols are chosen by whoever created the token, so they
 * are printed only after this: control characters (terminal escape codes),
 * zero-width and direction-override characters are removed, whitespace is
 * collapsed and the text is cut to `max` characters.
 */
export function cleanText(input: unknown, max = 40): string {
  if (typeof input !== "string") return "?";
  const text = input
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .trim();
  const chars = [...text];
  if (chars.length === 0) return "?";
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** A Launchpad token with a mining campaign, every figure read from the chain. */
export interface ListedToken {
  readonly token: Address;
  readonly campaign: Address;
  readonly name: string;
  readonly symbol: string;
  readonly start: bigint;
  readonly end: bigint;
  readonly opened: boolean;
  readonly status: number;
  readonly minedTotal: bigint;
  readonly miningReserve: bigint;
  readonly capTokens: bigint;
  readonly rewardPerProof: bigint;
  readonly proofFee: bigint;
  /** Chain time of the block the figures came from. */
  readonly now: bigint;
}

/** Whether a listed token can be mined right now (window open, reserve left). */
export const mineable = (t: ListedToken) => t.status === ACTIVE && t.opened && t.now >= t.start && t.now < t.end && t.minedTotal < t.miningReserve;

const LIST_VIEWS = ["opened", "start", "end", "status", "minedTotal", "miningReserve", "capTokens", "rewardPerProof", "proofFee"] as const;
const MAX_LIST = 200;
const MAX_INDEXER_BYTES = 2_000_000;

/**
 * The indexer's only job for the CLI: the addresses of the tokens on its
 * mining list (`/v1/markets?tab=mining`). Nothing else it sends is used —
 * every name, symbol and figure is read from the chain by `describeTokens`,
 * which also drops any address the Launchpad factory does not know. The
 * answer is size-capped, its paging values are checked before they go back
 * into a URL, and a malformed reply is an error (the chain list takes over).
 */
export async function indexerTokenAddresses(indexerUrl: string, max = MAX_LIST, fetchImpl: typeof fetch = fetch): Promise<Address[]> {
  const out = new Map<string, Address>();
  let offset = 0;
  let snap = "";
  for (let page = 0; page < 10 && out.size < max; page++) {
    const url = `${indexerUrl}/v1/markets?tab=mining&sort=ending&limit=50&offset=${offset}${snap ? `&snap=${snap}` : ""}`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000), redirect: "error" });
    if (!res.ok) throw new Error(`The indexer answered ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_INDEXER_BYTES) throw new Error("The indexer's answer is too large.");
    const body = JSON.parse(text) as { rows?: unknown; next?: unknown; snap?: unknown };
    if (!body || !Array.isArray(body.rows)) throw new Error("The indexer's answer has no rows.");
    for (const row of body.rows as { campaign?: { token?: unknown } | null }[]) {
      const token = row?.campaign?.token;
      if (typeof token === "string" && isAddress(token, { strict: false }) && out.size < max) out.set(token.toLowerCase(), getAddress(token));
    }
    const next = body.next;
    if (body.rows.length === 0 || typeof next !== "number" || !Number.isSafeInteger(next) || next <= offset) break;
    offset = next;
    if (typeof body.snap === "string" && /^\d{1,20}$/.test(body.snap)) snap = body.snap;
  }
  return [...out.values()];
}

/**
 * Reads tokens from the chain, in order: the factory's `campaignOf` first
 * (a token the factory did not make, or without a mining campaign, is
 * dropped), then name, symbol and the campaign figures, all from one block.
 */
export async function describeTokens(client: PublicClient, config: NetworkConfig, tokens: readonly Address[]): Promise<ListedToken[]> {
  if (tokens.length === 0) return [];
  const block = await client.getBlock();
  const at = { blockNumber: block.number, multicallAddress: MULTICALL3, batchSize: 16_384 } as const;
  const refs = await client.multicall({
    contracts: tokens.map((t) => ({ address: config.launchpad, abi: LAUNCHPAD_ABI, functionName: "campaignOf", args: [t] }) as const),
    allowFailure: true,
    ...at,
  });
  const known = tokens
    .map((token, i) => {
      const r = refs[i]!;
      return r.status === "success" && r.result[0] !== ZERO ? { token, campaign: getAddress(r.result[0]) } : null;
    })
    .filter((x): x is { token: Address; campaign: Address } => x !== null);
  if (known.length === 0) return [];
  const per = 2 + LIST_VIEWS.length;
  const calls = known.flatMap(({ token, campaign }) => [
    { address: token, abi: ERC20_ABI, functionName: "name" } as const,
    { address: token, abi: ERC20_ABI, functionName: "symbol" } as const,
    ...LIST_VIEWS.map((functionName) => ({ address: campaign, abi: CAMPAIGN_ABI, functionName }) as const),
  ]);
  const r = (await client.multicall({ contracts: calls as never, allowFailure: true, ...at })) as { status: string; result?: unknown }[];
  const out: ListedToken[] = [];
  known.forEach((ref, i) => {
    const slice = r.slice(i * per, (i + 1) * per);
    if (slice.slice(2).some((x) => x.status !== "success")) return;
    const v = (name: (typeof LIST_VIEWS)[number]) => slice[2 + LIST_VIEWS.indexOf(name)]!.result;
    out.push({
      ...ref,
      name: cleanText(slice[0]!.result),
      symbol: cleanText(slice[1]!.result, 16),
      opened: v("opened") as boolean,
      start: BigInt(v("start") as bigint),
      end: BigInt(v("end") as bigint),
      status: Number(v("status")),
      minedTotal: v("minedTotal") as bigint,
      miningReserve: v("miningReserve") as bigint,
      capTokens: v("capTokens") as bigint,
      rewardPerProof: v("rewardPerProof") as bigint,
      proofFee: v("proofFee") as bigint,
      now: block.timestamp,
    });
  });
  return out;
}

/** The factory's tokens, newest first (up to `max`). */
async function factoryTokens(client: PublicClient, config: NetworkConfig, max: number): Promise<Address[]> {
  const count = Number(await client.readContract({ address: config.launchpad, abi: LAUNCHPAD_ABI, functionName: "campaignCount" }));
  const from = Math.max(0, count - max);
  const idx = Array.from({ length: count - from }, (_, i) => count - 1 - i);
  if (idx.length === 0) return [];
  return (await client.multicall({
    contracts: idx.map((i) => ({ address: config.launchpad, abi: LAUNCHPAD_ABI, functionName: "tokens", args: [BigInt(i)] }) as const),
    allowFailure: false,
    multicallAddress: MULTICALL3,
    batchSize: 16_384,
  })) as Address[];
}

/** Every Launchpad token with a mining campaign, newest first, from the chain alone (up to `max`). */
export async function listFromChain(client: PublicClient, config: NetworkConfig, max = MAX_LIST): Promise<ListedToken[]> {
  return describeTokens(client, config, await factoryTokens(client, config, max));
}

/** Mining tokens: addresses from the indexer (checked on-chain), or the chain alone when there is no indexer or it fails. */
export async function listMiningTokens(client: PublicClient, config: NetworkConfig): Promise<{ tokens: ListedToken[]; source: "indexer" | "chain" }> {
  if (config.indexerUrl) {
    try {
      return { tokens: await describeTokens(client, config, await indexerTokenAddresses(config.indexerUrl)), source: "indexer" };
    } catch {
      // the chain below
    }
  }
  return { tokens: await listFromChain(client, config), source: "chain" };
}

/** What the token is wanted for: mining it, or claiming / sending what this wallet has of it. */
export type Purpose = "mine" | "hold" | "view";

/**
 * Finds the campaign a user means: a token address, a campaign address, or
 * a symbol (case-insensitive). Every answer is checked against the factory,
 * so a look-alike token can never be used.
 *
 * A symbol is looked up among the tokens this wallet used before (`known`)
 * and the mining list; only when neither has it, among every factory token
 * on the chain. Symbols are not unique, so with several matches the
 * purpose decides: `mine` keeps the ones mineable now, `hold` the ones this
 * wallet mined, holds or can claim, `view` the known ones. One left is the
 * answer; otherwise the CLI lists them and asks for the address.
 */
export async function resolveToken(
  client: PublicClient,
  config: NetworkConfig,
  query: string,
  opts: { purpose?: Purpose; wallet?: Address | null; known?: readonly Address[] } = {},
): Promise<{ token: Address; campaign: Address }> {
  const q = query.trim();
  const viaFactory = async (token: Address) => {
    const [campaign] = await client.readContract({ address: config.launchpad, abi: LAUNCHPAD_ABI, functionName: "campaignOf", args: [token] });
    return campaign === ZERO ? null : { token, campaign: getAddress(campaign) };
  };
  if (isAddress(q, { strict: false })) {
    const address = getAddress(q);
    const asToken = await viaFactory(address);
    if (asToken) return asToken;
    // perhaps the campaign itself
    try {
      const token = await client.readContract({ address, abi: CAMPAIGN_ABI, functionName: "token" });
      const back = await viaFactory(getAddress(token));
      if (back && back.campaign === address) return back;
    } catch {
      // not a campaign
    }
    throw new Error(`${address} is not a Launchpad mining token of this deployment. See: b20miner tokens`);
  }

  const wanted = q.replace(/^\$/, "").toLowerCase();
  const purpose = opts.purpose ?? "view";
  const known = opts.known ?? [];
  const match = (t: ListedToken) => t.symbol.toLowerCase() === wanted;
  const found = new Map<string, ListedToken>();
  const add = (list: readonly ListedToken[]) => list.filter(match).forEach((t) => found.set(t.token.toLowerCase(), t));
  add(await describeTokens(client, config, known));
  add((await listMiningTokens(client, config)).tokens);
  if (found.size === 0) add(await listFromChain(client, config, 1_000));
  const all = [...found.values()];
  if (all.length === 0) throw new Error(`No Launchpad mining token called "${cleanText(q, 16)}". See: b20miner tokens`);
  if (all.length === 1) return { token: all[0]!.token, campaign: all[0]!.campaign };

  const knownSet = new Set(known.map((k) => k.toLowerCase()));
  let preferred: ListedToken[];
  if (purpose === "mine") {
    // A token this CLI used before wins over a newcomer with the same symbol, even when it is not
    // mineable now: then nothing is picked and the addresses are listed (security review run-2).
    const usedBefore = all.filter((t) => knownSet.has(t.token.toLowerCase()));
    preferred = (usedBefore.length > 0 ? usedBefore : all).filter(mineable);
  }
  else if (purpose === "hold" && opts.wallet) {
    const w = opts.wallet;
    const r = await client.multicall({
      contracts: all.flatMap((t) => [
        { address: t.campaign, abi: CAMPAIGN_ABI, functionName: "minedOf", args: [w] } as const,
        { address: t.campaign, abi: CAMPAIGN_ABI, functionName: "claimable", args: [w] } as const,
        { address: t.token, abi: ERC20_ABI, functionName: "balanceOf", args: [w] } as const,
      ]),
      allowFailure: true,
      multicallAddress: MULTICALL3,
    });
    preferred = all.filter((_, i) => r.slice(i * 3, i * 3 + 3).some((x) => x.status === "success" && (x.result as bigint) > 0n));
  } else preferred = all.filter((t) => knownSet.has(t.token.toLowerCase()));
  if (preferred.length === 1) return { token: preferred[0]!.token, campaign: preferred[0]!.campaign };

  const shown = preferred.length > 1 ? preferred : all;
  const state = (t: ListedToken) => (mineable(t) ? "mining" : t.status === ACTIVE ? "not mining now" : "launched");
  throw new Error(`More than one token is called ${shown[0]!.symbol}. Name it by address:\n${shown.map((m) => `    ${m.token}  ${m.name} · ${state(m)}`).join("\n")}`);
}

/** Leading zero bits a hash needs to fall under `target`. */
export function zeroBits(target: bigint): number {
  return target > 0n ? 256 - target.toString(2).length : 256;
}
