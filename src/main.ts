#!/usr/bin/env node
import { BaseError, formatEther, formatUnits, parseEther, parseUnits, type Address, type PublicClient } from "viem";
import { APP_URL, VERSION, knownTokens, networkConfig, parseAddress, redactRpc, rewardsSetting, saveRewardsTo, saveToken, savedToken, walletPath } from "./config.ts";
import { ACTIVE, CAMPAIGN_ABI, ERC20_ABI, checkNetwork, listMiningTokens, publicClient, readCampaign, resolveToken, walletClient, zeroBits, type Campaign, type ListedToken, type Position, type Purpose } from "./chain.ts";
import { DEFAULT_MAX_COST_WEI, parseEthAmount } from "./costs.ts";
import { defaultWorkerCount, maxWorkerCount, resolveHasher } from "./hasher.ts";
import { amount, mine } from "./mine.ts";
import { readLine, readPassword } from "./prompt.ts";
import { deliveryNext, formatDuration, holderText, leftToMine, proofsLeft, readiness } from "./status.ts";
import { amber, bold, cobalt, err, heading, muted, ok, printBanner, rose, rows, warn } from "./ui.ts";
import { UPDATE_COMMAND, checkForUpdate, type UpdateCheck } from "./update.ts";
import { MIN_PASSWORD_LENGTH, WalletError, createWallet, deleteWallet, revealPrivateKey, unlockWallet, walletAddress, walletExists } from "./wallet.ts";

/**
 * B20MINER CLI — mines Launchpad tokens on Base Sepolia with a wallet kept
 * on this computer. That wallet sends every proof and pays the fees; each
 * proof credits it, or the user's own wallet when they chose one (only its
 * address — never its key). The tokens arrive there when the pool opens.
 */

if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error(`B20MINER CLI needs Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const config = networkConfig();

interface CommandHelp {
  readonly usage: string;
  readonly summary: string;
  readonly details: readonly string[];
}

/** Every command, grouped as the help screen shows them. */
const GROUPS: ReadonlyArray<{ readonly title: string; readonly commands: readonly CommandHelp[] }> = [
  {
    title: "Mining",
    commands: [
      {
        usage: "b20miner tokens",
        summary: "Launchpad tokens you can mine now",
        details: ["No password needed. Shows each token's reward, fee, how much is mined and when mining ends."],
      },
      {
        usage: "b20miner start [TOKEN]",
        summary: "Mine a token with this computer's wallet (same as: b20miner mine)",
        details: [
          "TOKEN is a symbol (TEST1) or the token's address; without it, the last token you mined.",
          "This computer's wallet sends the proofs and pays the token's proof fee plus gas.",
          "Every accepted proof credits the rewards wallet: this wallet, or your own wallet.",
          "The first start asks which (b20miner rewards changes it); only the address is kept.",
          "When mining ends the pool opens and the tokens arrive in the rewards wallet by themselves.",
          "Stops when that wallet's quota or the token's reserve is mined. Ctrl+C stops at once.",
          "Waits by itself when an hour's release is mined out (tokens with an hourly schedule).",
          "Refuses to start if a newer b20miner on npm mines a different deployment (update first).",
          "Options: --for 0x…|self  (rewards wallet for this and later starts)",
          "         --workers N     (CPU workers, default half your cores)",
          "         --proofs N      (stop after N accepted proofs)",
          "         --max-cost ETH  (most one proof may cost incl. gas; default 0.0002)",
        ],
      },
      {
        usage: "b20miner status [TOKEN]",
        summary: "One token: window, mined, your share, what happens next",
        details: ["No password needed. Without TOKEN, the last token you mined. Shows the rewards wallet's share."],
      },
      {
        usage: "b20miner rewards [0xADDRESS|self]",
        summary: "Show or set where mined tokens go",
        details: [
          "0xADDRESS: your own wallet. Proofs credit it and the tokens arrive in it; this CLI's wallet only pays fees.",
          "Only the address is kept: the CLI never asks for that wallet's key or seed phrase.",
          "Claims for your own wallet are made on the Launchpad with that wallet, not in the CLI.",
          "self: this CLI's wallet receives the tokens (move them on with b20miner send).",
          "Setting it asks you to type yes after showing the address.",
        ],
      },
      {
        usage: "b20miner claim TOKEN",
        summary: "Claim the vested part of a mined token",
        details: [
          "Only for tokens with claim vesting: 25% arrives when the pool opens, the rest vests.",
          "Claims everything vested so far into this CLI's wallet. Asks for the password.",
          "Tokens mined for your own wallet are claimed on the Launchpad with that wallet.",
        ],
      },
    ],
  },
  {
    title: "Wallet",
    commands: [
      {
        usage: "b20miner wallet create",
        summary: "Create the wallet on this computer (shows its key once)",
        details: [
          "Choose a password (twice). It encrypts the key on this computer.",
          "This wallet pays fees and gas. Tokens go to it, or to your own wallet if you choose one.",
          "The address and private key are shown once: save the key somewhere safe.",
        ],
      },
      {
        usage: "b20miner balance",
        summary: "ETH and mined tokens in the wallet",
        details: ["No password needed."],
      },
      {
        usage: "b20miner send ASSET TO [AMOUNT|all]",
        summary: "Send ETH or a token from the wallet",
        details: [
          "ASSET is ETH, a token symbol or a token address. TO is any address.",
          "AMOUNT is in whole units (0.01, 2500) or all. Shows the transfer and asks before sending.",
          "Examples: b20miner send TEST1 0xYOUR_WALLET all",
          "          b20miner send ETH 0xYOUR_WALLET 0.002",
        ],
      },
      {
        usage: "b20miner wallet show",
        summary: "The wallet's address and where it is stored",
        details: ["No password needed. Send Base Sepolia ETH to this address before mining."],
      },
      {
        usage: "b20miner wallet key",
        summary: "Show the private key again",
        details: ["Asks for the password, then prints the key. Never share it."],
      },
      {
        usage: "b20miner wallet delete",
        summary: "Delete the wallet from this computer",
        details: ["You must type DELETE. Its ETH and tokens stay on-chain but only the saved private key can reach them."],
      },
    ],
  },
  {
    title: "Information",
    commands: [
      {
        usage: "b20miner info",
        summary: "Network, Launchpad contract, hasher, CPU workers, version",
        details: ["Also shows whether the fast native hasher is in use and how many CPU workers you can run."],
      },
      {
        usage: "b20miner help [command]",
        summary: "This screen, or details for one command",
        details: ["Example: b20miner help start"],
      },
    ],
  },
];

const ALIASES: Record<string, string> = { mine: "start", list: "tokens", "--help": "help", "-h": "help" };

function quickStart(): void {
  console.log(heading("Quick start"));
  console.log(`  ${cobalt("1")}  ${bold("b20miner wallet create".padEnd(26))}  ${muted("then send it a little Base Sepolia ETH")}`);
  console.log(`  ${cobalt("2")}  ${bold("b20miner tokens".padEnd(26))}  ${muted("pick a token that is mining")}`);
  console.log(`  ${cobalt("3")}  ${bold("b20miner start SYMBOL".padEnd(26))}  ${muted("mine · Ctrl+C stops")}`);
}

function help(): void {
  quickStart();
  const width = Math.max(...GROUPS.flatMap((g) => g.commands.map((c) => c.usage.length)));
  for (const group of GROUPS) {
    console.log(heading(group.title));
    for (const c of group.commands) console.log(`  ${bold(c.usage.padEnd(width))}  ${muted(c.summary)}`);
  }
  console.log(`\n  ${muted("Details for one command:")} ${bold("b20miner help start")}`);
  console.log(`  ${muted(`Base Sepolia test network: test tokens with no value. Launchpad: ${APP_URL}`)}\n`);
}

function findCommand(name: string): CommandHelp | null {
  const key = ALIASES[name] ?? name;
  for (const group of GROUPS) {
    for (const c of group.commands) {
      const words = c.usage.replace(/^b20miner /, "").split(" ").filter((w) => !w.startsWith("[") && w !== w.toUpperCase());
      if (words.join(" ") === key || words[0] === key) return c;
    }
  }
  return null;
}

function commandHelp(name: string): void {
  const c = findCommand(name);
  if (!c) {
    console.log(err(`No command called "${name}".`));
    help();
    return;
  }
  console.log(heading(c.usage));
  console.log(`  ${c.summary}\n`);
  for (const line of c.details) console.log(`  ${muted("·")} ${line}`);
  console.log("");
}

/** Closest known command for a typo, e.g. "strat" -> "start". */
function suggest(input: string): string | null {
  const names = ["tokens", "start", "mine", "status", "claim", "rewards", "balance", "send", "wallet", "info", "help"];
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  const best = names.map((n) => [n, dist(input, n)] as const).sort((a, b) => a[1] - b[1])[0]!;
  return best[1] <= 2 ? best[0] : null;
}

/** Prints the update notice; returns true when this CLI mines a retired deployment. */
function printUpdate(u: UpdateCheck): boolean {
  if (u.kind === "retired") {
    console.log(err(`This CLI (v${VERSION}) mines a retired Launchpad.`));
    console.log(`    ${muted("It mines tokens of")} ${config.launchpad}${muted(`, but b20miner@${u.latest} mines`)} ${u.latestLaunchpad}${muted(".")}`);
    console.log(`    ${bold("Update:")} ${cobalt(UPDATE_COMMAND)}\n`);
    return true;
  }
  if (u.kind === "newer") {
    console.log(warn(`b20miner ${u.latest} is available (you have ${VERSION}). Update: ${cobalt(UPDATE_COMMAND)}`));
    console.log("");
  }
  return false;
}

const percent = (part: bigint, whole: bigint) => (whole > 0n ? `${(Number((part * 10_000n) / whole) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%` : "—");
const utc = (t: bigint) => `${new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** Whole token units for a short line: "12,500". */
const units = (wei: bigint, digits = 2) => Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: digits });

function windowText(c: Campaign): string {
  if (c.status !== ACTIVE) return muted("over · the token has launched");
  if (!c.opened) return amber("not open yet");
  if (c.now < c.start) return `${amber("starts")} ${muted(`in ${formatDuration(c.start - c.now)} · ${utc(c.start)}`)}`;
  if (c.now >= c.end) return muted(`closed ${utc(c.end)}`);
  return `${rose("open")} ${muted(`· ends in ${formatDuration(c.end - c.now)} · ${utc(c.end)}`)}`;
}

function printCampaign(c: Campaign, p: Position, to: Address | null): void {
  const left = leftToMine(c, p);
  const proofs = proofsLeft(left, c.rewardPerProof);
  console.log(rows([
    ["Token", `${bold(c.symbol)} ${muted(`${c.name} · ${c.token}`)}`],
    ["Mining", windowText(c)],
    ["Reward", `${rose(amount(c.rewardPerProof, c.symbol, 1))} per proof ${muted(`· fee ${formatEther(c.proofFee)} ETH + gas · ${zeroBits(c.powTarget)} zero bits`)}`],
    ["Mined in all", `${amount(c.minedTotal, c.symbol)} ${muted(`of ${units(c.miningReserve)} · ${percent(c.minedTotal, c.miningReserve)}`)}`],
    [to ? "Your wallet" : "This wallet", `${bold(amount(p.mined, c.symbol))} ${muted(`· ${p.proofs} proof${p.proofs === 1n ? "" : "s"} · quota ${units(c.capTokens)}`)}`],
    ...(c.status === ACTIVE ? ([["Left to mine", `${amount(left, c.symbol)} ${muted(`· ${proofs} proof${proofs === 1n ? "" : "s"}`)}`]] as const) : []),
    ...(to ? ([["Rewards to", `${bold(to)} ${muted("(your wallet)")}`]] as const) : []),
    ["In the wallet", amount(p.balance, c.symbol)],
    ...(p.claimable > 0n ? ([["Claimable", `${rose(amount(p.claimable, c.symbol))} ${muted(to ? `· on ${APP_URL} with that wallet` : "· b20miner claim")}`]] as const) : []),
    ...(c.hourlySchedule && c.status === ACTIVE ? ([["Hourly release", `${muted("next share")} ${c.nextReleaseAt > c.now ? `in ${formatDuration(c.nextReleaseAt - c.now)}` : "now"}`]] as const) : []),
  ]));
  const r = readiness(c, p, to);
  if (r.ready) console.log(`\n  ${bold("Next:")} ${cobalt(`b20miner start ${c.symbol}`)} ${muted("· Ctrl+C stops")}`);
  else console.log(`\n${warn(r.message)}\n  ${bold("Next:")} ${r.next}`);
  if (r.ready && p.mined > 0n) console.log(`  ${muted(deliveryNext(c, p, to))}`);
}

/** The rewards wallet when it is the user's own, null when it is this CLI's wallet (or not chosen yet). */
function rewardsTo(): Address | null {
  const v = rewardsSetting();
  return v && v !== "self" && (!walletExists() || v !== walletAddress()) ? v : null;
}

/** Asks for the rewards wallet, shows it back and waits for "yes"; returns null for this CLI's wallet. */
async function askRewardsTo(self: Address, typed?: string): Promise<Address | null> {
  let answer = typed;
  if (answer === undefined) {
    console.log(heading("Where should the mined tokens go?"));
    console.log(`  ${bold("Enter".padEnd(10))}  ${muted("this CLI's wallet")} ${self}`);
    console.log(`  ${bold("0x…".padEnd(10))}  ${muted("your own wallet: only its address — never its key or seed phrase")}`);
    answer = (await readLine("\n  Rewards to: ")).trim();
  }
  if (answer === "" || answer.toLowerCase() === "self") {
    saveRewardsTo("self");
    console.log(ok(`Tokens go to this CLI's wallet ${self}.`));
    return null;
  }
  const to = parseAddress(answer);
  if (to === self) {
    saveRewardsTo("self");
    console.log(ok(`That is this CLI's wallet; tokens go to ${self}.`));
    return null;
  }
  console.log(`\n  ${warn(`Every proof will credit ${bold(to)}. Its tokens arrive there and only that wallet can claim them.`)}`);
  console.log(`  ${muted("Check the address character by character: tokens sent to a wrong address are lost.")}`);
  if ((await readLine(`  Type ${bold("yes")} if this is your wallet: `)).trim().toLowerCase() !== "yes") throw new Error("Rewards wallet not changed.");
  saveRewardsTo(to);
  console.log(ok(`Rewards go to your wallet ${to}.`));
  return to;
}

/** Looks a token up for one purpose, with this wallet's known tokens first. */
function findToken(client: PublicClient, query: string, purpose: Purpose): Promise<{ token: Address; campaign: Address }> {
  return resolveToken(client, config, query, { purpose, wallet: walletExists() ? walletAddress() : null, known: knownTokens() });
}

/** The token named on the command line, or the last one mined. */
async function tokenFrom(client: PublicClient, arg: string | undefined, purpose: Purpose): Promise<{ token: Address; campaign: Address }> {
  if (arg && !arg.startsWith("--")) return findToken(client, arg, purpose);
  const saved = savedToken();
  if (!saved) throw new Error("Which token? Name it, for example: b20miner start TEST1   (b20miner tokens lists them)");
  return resolveToken(client, config, saved);
}

async function home(): Promise<void> {
  const update = checkForUpdate();
  printBanner(VERSION, config.name);
  printUpdate(await update);
  if (!walletExists()) {
    console.log(`  ${amber("No wallet yet.")}`);
    console.log(`  ${bold("Next:")} ${cobalt("b20miner wallet create")}`);
    help();
    return;
  }
  const address = walletAddress();
  const saved = savedToken();
  try {
    const client = publicClient(config);
    const eth = await client.getBalance({ address });
    const ref = saved ? await resolveToken(client, config, saved).catch(() => null) : null;
    const to = rewardsTo();
    const read = ref ? await readCampaign(client, ref, to ?? address) : null;
    console.log(rows([
      ["Wallet", `${bold(address)} ${muted(`· ${formatEther(eth)} ETH`)}`],
      ["Rewards to", to ? `${bold(to)} ${muted("(your wallet)")}` : rewardsSetting() ? muted("this wallet") : amber("asked at the first start")],
      ["Token", read ? `${bold(read.c.symbol)} ${muted(`· mined ${amount(read.p!.mined, read.c.symbol)}`)}` : amber("none yet")],
    ]));
    if (eth < 200_000_000_000_000n) {
      console.log(`\n  ${bold("Next:")} send a little ${config.name} ETH to the wallet, then ${cobalt("b20miner tokens")}`);
    } else if (!read) {
      console.log(`\n  ${bold("Next:")} ${cobalt("b20miner tokens")} ${muted("then")} ${cobalt("b20miner start SYMBOL")}`);
    } else {
      const r = readiness(read.c, read.p!, to);
      console.log(`\n  ${bold("Next:")} ${r.ready ? `${cobalt("b20miner start")} ${muted("· Ctrl+C stops")}` : `${r.message} ${muted("Other tokens:")} ${cobalt("b20miner tokens")}`}`);
    }
  } catch {
    console.log(`  ${muted("Wallet")}  ${bold(address)}  ${warn("RPC not reachable right now")}`);
  }
  help();
}

async function walletCreate(): Promise<void> {
  printBanner(VERSION, config.name);
  if (walletExists()) {
    console.log(err(`A wallet already exists: ${walletAddress()}`));
    console.log(`    Delete it first with ${bold("b20miner wallet delete")} if you really want a new one.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  Choose a password (at least ${MIN_PASSWORD_LENGTH} characters). It encrypts the key on this computer.`);
  console.log(`  ${muted("There is no reset: without the password the stored key cannot be used.")}\n`);
  const p1 = await readPassword("  Password: ");
  const p2 = await readPassword("  Repeat:   ");
  if (p1 !== p2) throw new WalletError("The passwords do not match. Nothing was created.");
  const { address, privateKey } = createWallet(p1);

  console.log(heading("Wallet created"));
  console.log(rows([
    ["Address", bold(address)],
    ["Private key", amber(privateKey)],
    ["Stored at", walletPath()],
  ]));
  console.log(`\n${warn("Save the private key somewhere safe now. Anyone who has it controls this wallet's ETH and tokens.")}`);
  console.log(`${warn("The first b20miner start asks where the mined tokens go: this wallet, or your own wallet (address only).")}`);
  console.log(`\n  ${bold("Next:")} send a little ${config.name} ETH (e.g. 0.005) to ${bold(address)}, then run ${cobalt("b20miner tokens")}\n`);
}

async function walletShow(): Promise<void> {
  const address = walletAddress();
  console.log(heading("Wallet"));
  console.log(rows([
    ["Address", bold(address)],
    ["Stored at", walletPath()],
    ["Network", config.name],
  ]));
  console.log("");
}

async function walletKey(): Promise<void> {
  const address = walletAddress();
  console.log(`\n  ${warn(`The private key of ${address} will be shown on screen.`)}`);
  const password = await readPassword("  Password: ");
  const key = revealPrivateKey(password);
  console.log(`\n  ${muted("Private key")}  ${amber(key)}\n`);
}

async function walletDelete(): Promise<void> {
  const address = walletAddress();
  console.log(`\n  ${warn(`This deletes ${bold(address)} from this computer.`)}`);
  console.log(`  ${muted("Its ETH and tokens stay on-chain but can only be reached with the private key you saved.")}`);
  const answer = await readLine(`  Type ${bold("DELETE")} to confirm: `);
  if (answer.trim() !== "DELETE") {
    console.log(`  ${muted("Nothing deleted.")}\n`);
    return;
  }
  deleteWallet();
  console.log(ok("Wallet deleted.") + "\n");
}

/** Tokens this wallet mined from this computer (remembered by `start`), checked against the factory. */
async function minedTokens(client: PublicClient): Promise<{ token: Address; campaign: Address }[]> {
  const out: { token: Address; campaign: Address }[] = [];
  for (const token of knownTokens()) {
    const ref = await resolveToken(client, config, token).catch(() => null);
    if (ref) out.push(ref);
  }
  return out;
}

async function balance(): Promise<void> {
  const address = walletAddress();
  const to = rewardsTo();
  const client = publicClient(config);
  const [eth, refs] = await Promise.all([client.getBalance({ address }), minedTokens(client)]);
  console.log(heading("Wallet"));
  console.log(rows([
    ["Address", bold(address)],
    ["ETH", `${formatEther(eth)} ETH`],
    ...(to ? ([["Rewards to", `${bold(to)} ${muted("(your wallet)")}`]] as const) : []),
    ["Network", config.name],
  ]));
  const holders: Array<[Address, Address | null, string]> = to ? [[to, to, `Tokens in your wallet ${to}`], [address, null, "Tokens in this wallet"]] : [[address, null, "Mined tokens"]];
  for (const [holder, label, title] of holders) {
    const reads = (await Promise.all(refs.map((ref) => readCampaign(client, ref, holder)))).filter(({ p }) => p!.mined > 0n || p!.balance > 0n || p!.claimable > 0n);
    if (reads.length === 0) continue;
    console.log(heading(title));
    console.log(rows(reads.map(({ c, p }) => [c.symbol, `${bold(amount(p!.balance, c.symbol))} ${muted("held")} ${muted(`· mined ${units(p!.mined)}${p!.claimable > 0n ? ` · ${units(p!.claimable)} claimable` : ""}`)}`] as const)));
    for (const { c, p } of reads) {
      if (p!.mined > p!.balance && c.status === ACTIVE) console.log(`  ${muted(`${c.symbol}: ${deliveryNext(c, p!, label)}`)}`);
    }
  }
  console.log("");
}

function tokenLine(t: ListedToken, now: bigint): string {
  const time = !t.opened ? amber("not open") : now < t.start ? amber(`starts in ${formatDuration(t.start - now)}`) : now >= t.end ? muted("closed") : `${rose("open")} ${muted(`ends in ${formatDuration(t.end - now)}`)}`;
  return `${time} ${muted("·")} ${amount(t.rewardPerProof, t.symbol, 1)} ${muted(`per proof · fee ${formatEther(t.proofFee)} ETH · mined ${percent(t.minedTotal, t.miningReserve)}`)}`;
}

async function tokens(): Promise<void> {
  const client = publicClient(config);
  await checkNetwork(client, config);
  const { tokens: list, source } = await listMiningTokens(client, config);
  const mining = list.filter((t) => t.status === ACTIVE && t.campaign);
  console.log(heading("Mining tokens"));
  if (mining.length === 0) {
    console.log(`  ${muted("No token is mining right now. New tokens are made in")} ${APP_URL}\n`);
    return;
  }
  const w = Math.max(...mining.map((t) => t.symbol.length));
  for (const t of mining) {
    console.log(`  ${bold(t.symbol.padEnd(w))}  ${tokenLine(t, t.now)}`);
    console.log(`  ${" ".repeat(w)}  ${muted(`${t.name} · ${t.token}`)}`);
  }
  console.log(`\n  ${bold("Next:")} ${cobalt(`b20miner start ${mining[0]!.symbol}`)} ${muted(`· ${mining.length} token${mining.length === 1 ? "" : "s"} · from the ${source}`)}\n`);
}

async function status(args: string[]): Promise<void> {
  const update = checkForUpdate();
  const client = publicClient(config);
  await checkNetwork(client, config);
  const ref = await tokenFrom(client, args[0], "view");
  const to = rewardsTo();
  const owner = to ?? (walletExists() ? walletAddress() : null);
  const { c, p } = await readCampaign(client, ref, owner ?? undefined);
  console.log(heading(`${c.symbol} mining`));
  if (p) printCampaign(c, p, to);
  else {
    console.log(rows([
      ["Token", `${bold(c.symbol)} ${muted(`${c.name} · ${c.token}`)}`],
      ["Mining", windowText(c)],
      ["Mined in all", `${amount(c.minedTotal, c.symbol)} ${muted(`of ${units(c.miningReserve)} · ${percent(c.minedTotal, c.miningReserve)}`)}`],
    ]));
    console.log(`\n  ${bold("Next:")} ${cobalt("b20miner wallet create")}`);
  }
  console.log("");
  printUpdate(await update);
}

function versionText(u: UpdateCheck): string {
  if (u.kind === "retired") return `${VERSION} ${amber(`· retired Launchpad, b20miner@${u.latest} is current`)}`;
  if (u.kind === "newer") return `${VERSION} ${amber(`· ${u.latest} available`)}`;
  if (u.kind === "current") return `${VERSION} ${muted("· latest")}`;
  return `${VERSION} ${muted("· could not check npm")}`;
}

async function info(): Promise<void> {
  const update = checkForUpdate();
  const client = publicClient(config);
  await checkNetwork(client, config);
  const u = await update;
  console.log(heading("Network"));
  console.log(rows([
    ["Network", `${config.name} (${config.chainId})`],
    ["RPC", redactRpc(config.rpcUrl)],
    ["Launchpad", `${config.launchpad} ${muted("(LaunchpadFactory)")}`],
    ["Token list", config.indexerUrl ? `${config.indexerUrl} ${muted("(chain if it fails)")}` : muted("chain only")],
    ["Hasher", resolveHasher().path ? `native (${resolveHasher().kind})` : amber("built-in (slower) — no C compiler found")],
    ["CPU workers", `default ${defaultWorkerCount()}, up to ${maxWorkerCount()}`],
    ["Wallet", walletExists() ? walletAddress() : amber("none yet")],
    ["Rewards to", rewardsTo() ?? (rewardsSetting() ? muted("this wallet") : amber("asked at the first start"))],
    ["CLI version", versionText(u)],
  ]));
  console.log("");
  if (u.kind !== "current" && u.kind !== "unknown") printUpdate(u);
}

function parseCount(args: string[], name: string): number | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} needs a whole number.`);
  return value;
}

function parseMaxCost(args: string[]): bigint {
  const i = args.indexOf("--max-cost");
  if (i < 0) return DEFAULT_MAX_COST_WEI;
  return parseEthAmount(args[i + 1] ?? "", "--max-cost");
}

async function mineCommand(args: string[]): Promise<void> {
  printBanner(VERSION, config.name);
  const workers = parseCount(args, "--workers") ?? defaultWorkerCount();
  if (workers < 1 || workers > maxWorkerCount()) throw new Error(`--workers must be between 1 and ${maxWorkerCount()}.`);
  const maxProofs = parseCount(args, "--proofs") ?? 0;
  const maxCostWei = parseMaxCost(args);
  const address = walletAddress();
  const forIndex = args.indexOf("--for");
  const forValue = forIndex >= 0 ? args[forIndex + 1] : undefined;
  if (forIndex >= 0 && (!forValue || forValue.startsWith("--"))) throw new Error("--for needs your wallet address, or self for this CLI's wallet.");

  const update = checkForUpdate();
  const client = publicClient(config);
  await checkNetwork(client, config);
  const ref = await tokenFrom(client, args[0], "mine");
  // The rewards wallet: chosen once (asked at the first start), changed with --for or b20miner rewards.
  let to: Address | null;
  if (forValue !== undefined) to = await askRewardsTo(address, forValue);
  else if (rewardsSetting() === null && process.stdin.isTTY) to = await askRewardsTo(address);
  else to = rewardsTo();
  const [{ c, p }, u] = await Promise.all([readCampaign(client, ref, to ?? address), update]);
  // Never spend the user's ETH on a Launchpad the newest CLI no longer mines.
  if (printUpdate(u)) {
    process.exitCode = 1;
    return;
  }
  saveToken(c.token);

  console.log(heading(`${c.symbol} mining`));
  printCampaign(c, p!, to);
  const r = readiness(c, p!, to);
  if (!r.ready && r.blocker !== "hourly") {
    console.log("");
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${muted("Wallet")}  ${bold(address)}${to ? ` ${muted(`pays the fees · rewards to ${holderText(to)}`)}` : ""}`);
  if (!resolveHasher().path) console.log(warn("No native hasher for this system; using the slower built-in one."));
  const password = await readPassword("  Password: ");
  const account = unlockWallet(password);
  await mine(config, client, account, c, { workers, maxProofs, maxCostWei, rewardsTo: to });
}

async function claim(args: string[]): Promise<void> {
  if (!args[0]) throw new Error("Which token? Use: b20miner claim TEST1");
  const address = walletAddress();
  const client = publicClient(config);
  await checkNetwork(client, config);
  const ref = await findToken(client, args[0], "hold");
  const { c, p } = await readCampaign(client, ref, address);
  if (p!.claimable === 0n) {
    const to = rewardsTo();
    const theirs = to ? (await readCampaign(client, ref, to)).p! : null;
    if (theirs && theirs.claimable > 0n) {
      console.log(`\n  ${amount(theirs.claimable, c.symbol)} ${muted(`is claimable by your wallet ${to}. Only that wallet can claim it: on ${APP_URL}, with that wallet.`)}\n`);
      return;
    }
    console.log(`\n  ${muted(`Nothing of ${c.symbol} to claim now.`)} ${theirs ? deliveryNext(c, theirs, to) : deliveryNext(c, p!)}\n`);
    return;
  }
  console.log(`\n  ${bold("Claim")} ${rose(amount(p!.claimable, c.symbol))} ${muted("into")} ${address}`);
  const account = unlockWallet(await readPassword("  Password: "));
  const wallet = walletClient(config, account);
  const hash = await wallet.writeContract({ address: c.campaign, abi: CAMPAIGN_ABI, functionName: "claim", account, chain: wallet.chain });
  console.log(`  ${muted("Sent")} ${config.explorerTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The claim reverted.");
  console.log(ok(`Claimed ${amount(p!.claimable, c.symbol)}.`) + "\n");
}

/** `rewards [0xADDRESS|self]`: shows or sets the rewards wallet. */
async function rewardsCommand(args: string[]): Promise<void> {
  const address = walletAddress();
  if (args[0]) {
    await askRewardsTo(address, args[0]);
    console.log("");
    return;
  }
  const to = rewardsTo();
  console.log(heading("Rewards"));
  console.log(rows([
    ["Rewards to", to ? `${bold(to)} ${muted("(your wallet)")}` : rewardsSetting() ? `${bold(address)} ${muted("(this CLI's wallet)")}` : amber("not chosen yet: the first start asks")],
    ["Fees paid by", `${address} ${muted("(this CLI's wallet)")}`],
  ]));
  console.log(`\n  ${muted("Change it:")} ${cobalt("b20miner rewards 0xYOUR_WALLET")} ${muted("or")} ${cobalt("b20miner rewards self")}\n`);
}

/** `send ASSET TO [AMOUNT|all]`: ETH or a Launchpad token out of the wallet, after a yes. */
async function send(args: string[]): Promise<void> {
  const [asset, toArg, amountArg = "all"] = args;
  if (!asset || !toArg) throw new Error("Use: b20miner send ETH|TOKEN 0xTO [AMOUNT|all]   (b20miner help send)");
  const to = parseAddress(toArg);
  const address = walletAddress();
  if (to === address) throw new Error("That is this wallet's own address.");
  const client = publicClient(config);
  await checkNetwork(client, config);
  const isEth = asset.toUpperCase() === "ETH";
  const all = amountArg.toLowerCase() === "all";

  if (isEth) {
    const [eth, fees] = await Promise.all([client.getBalance({ address }), client.estimateFeesPerGas()]);
    // A plain transfer uses 21,000 gas; keep room for it (twice the fee, for a moving base fee).
    const reserve = 21_000n * fees.maxFeePerGas * 2n;
    const value = all ? eth - reserve : parseEther(amountArg);
    if (value <= 0n || value + 21_000n * fees.maxFeePerGas > eth) throw new Error(`Not enough ETH: the wallet holds ${formatEther(eth)} ETH.`);
    console.log(`\n  ${bold("Send")} ${rose(`${formatEther(value)} ETH`)} ${muted("to")} ${to}`);
    if ((await readLine(`  Type ${bold("yes")} to send: `)).trim().toLowerCase() !== "yes") return void console.log(`  ${muted("Nothing sent.")}\n`);
    const account = unlockWallet(await readPassword("  Password: "));
    const wallet = walletClient(config, account);
    const hash = await wallet.sendTransaction({ to, value, account, chain: wallet.chain });
    console.log(`  ${muted("Sent")} ${config.explorerTx(hash)}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transfer reverted.");
    console.log(ok(`Sent ${formatEther(value)} ETH.`) + "\n");
    return;
  }

  const ref = await findToken(client, asset, "hold");
  const { c, p } = await readCampaign(client, ref, address);
  const held = p!.balance;
  const value = all ? held : parseUnits(amountArg, 18);
  if (value <= 0n || value > held) throw new Error(`Not enough ${c.symbol}: the wallet holds ${amount(held, c.symbol)}.`);
  console.log(`\n  ${bold("Send")} ${rose(amount(value, c.symbol, 6))} ${muted("to")} ${to}`);
  if ((await readLine(`  Type ${bold("yes")} to send: `)).trim().toLowerCase() !== "yes") return void console.log(`  ${muted("Nothing sent.")}\n`);
  const account = unlockWallet(await readPassword("  Password: "));
  const wallet = walletClient(config, account);
  const hash = await wallet.writeContract({ address: c.token, abi: ERC20_ABI, functionName: "transfer", args: [to, value], account, chain: wallet.chain });
  console.log(`  ${muted("Sent")} ${config.explorerTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transfer reverted.");
  console.log(ok(`Sent ${amount(value, c.symbol, 6)}.`) + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [rawCmd, sub] = args;
  const cmd = rawCmd === undefined ? undefined : (ALIASES[rawCmd] ?? rawCmd);
  switch (cmd) {
    case undefined:
      return home();
    case "help":
      printBanner(VERSION, config.name);
      if (sub) return commandHelp(sub);
      return help();
    case "--version":
    case "-v":
    case "version":
      console.log(VERSION);
      return;
    case "wallet":
      if (sub === "create" || sub === "new") return walletCreate();
      if (sub === "show") return walletShow();
      if (sub === "key") return walletKey();
      if (sub === "delete") return walletDelete();
      throw new Error("Use: b20miner wallet create | show | key | delete   (b20miner help wallet)");
    case "balance":
      return balance();
    case "tokens":
      return tokens();
    case "status":
      return status(args.slice(1));
    case "start":
      return mineCommand(args.slice(1));
    case "claim":
      return claim(args.slice(1));
    case "rewards":
      return rewardsCommand(args.slice(1));
    case "send":
      return send(args.slice(1));
    case "info":
      return info();
    default: {
      const hint = suggest(rawCmd!);
      throw new Error(`Unknown command "${rawCmd}".${hint ? ` Did you mean: b20miner ${hint}` : ""}  (b20miner help)`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  console.error(`\n${err(message)}\n`);
  process.exitCode = 1;
});
