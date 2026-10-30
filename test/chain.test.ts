import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type PublicClient } from "viem";
import { cleanText, describeTokens, indexerTokenAddresses, resolveToken } from "../src/chain.ts";
import type { NetworkConfig } from "../src/config.ts";

const FACTORY = "0x315Ce9b1a8473e3b2D10d4195F15470A66b7848d" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const config = { name: "Base Sepolia", chainId: 84532, rpcUrl: "http://127.0.0.1:1", indexerUrl: "https://indexer.test", launchpad: FACTORY } as unknown as NetworkConfig;

test("cleanText strips terminal escapes, invisible and direction characters, and caps the length", () => {
  assert.equal(cleanText("\u001b[2J\u001b[31mEVIL\u001b[0m"), "[2J[31mEVIL[0m");
  assert.equal(cleanText("A‮B​C\u0007"), "ABC");
  assert.equal(cleanText("  two\n\nlines  "), "two lines");
  assert.equal(cleanText("x".repeat(50), 10), `${"x".repeat(9)}…`);
  assert.equal(cleanText(""), "?");
  assert.equal(cleanText(42), "?");
});

function reply(pages: unknown[]): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const body = pages[Math.min(i++, pages.length - 1)];
    return typeof body === "string" ? new Response(body) : new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { fetch: f, urls };
}

test("the indexer gives addresses only; everything else in its answer is ignored", async () => {
  const { fetch } = reply([
    {
      rows: [
        { campaign: { token: addr(1).toLowerCase(), name: "\u001b[31mfake", symbol: "FAKE", mining: { rewardPerProof: "999" } } },
        { campaign: { token: "not-an-address" } },
        { campaign: null },
        { campaign: { token: addr(1) } },
        { campaign: { token: addr(2) } },
      ],
      next: 0,
    },
  ]);
  assert.deepEqual(await indexerTokenAddresses("https://indexer.test", 200, fetch), [addr(1), addr(2)]);
});

test("indexer paging values are checked before they go back into a URL", async () => {
  const { fetch, urls } = reply([
    { rows: [{ campaign: { token: addr(1) } }], next: 50, snap: "123&tab=all" },
    { rows: [{ campaign: { token: addr(2) } }], next: 50 },
  ]);
  await indexerTokenAddresses("https://indexer.test", 200, fetch);
  assert.equal(urls.length, 2, "a repeated next ends the paging");
  assert.ok(!urls[1]!.includes("snap="), "a snap that is not digits is dropped");
  const loop = reply([{ rows: [{ campaign: { token: addr(1) } }], next: 1e9 + 0.5 }]);
  await indexerTokenAddresses("https://indexer.test", 200, loop.fetch);
  assert.equal(loop.urls.length, 1, "a non-integer next ends the paging");
});

test("a broken, oversized or failing indexer answer is an error (the chain list takes over)", async () => {
  await assert.rejects(indexerTokenAddresses("https://indexer.test", 200, reply(["{not json"]).fetch));
  await assert.rejects(indexerTokenAddresses("https://indexer.test", 200, reply([{ rows: "x" }]).fetch));
  await assert.rejects(indexerTokenAddresses("https://indexer.test", 200, reply(["[" + " ".repeat(2_000_001) + "]"]).fetch), /too large/);
  const down = (async () => new Response("no", { status: 503 })) as typeof fetch;
  await assert.rejects(indexerTokenAddresses("https://indexer.test", 200, down), /503/);
});

/**
 * A fake chain: token n has campaign 0x…1000+n (0 = not from the factory),
 * the given symbol, and the given wallet figures.
 */
function chain(tokens: Record<number, { symbol: string; campaign?: number; status?: number; end?: bigint; mined?: bigint }>): PublicClient {
  const byToken = (a: string) => Object.entries(tokens).find(([n]) => addr(Number(n)).toLowerCase() === a.toLowerCase());
  const byCampaign = (a: string) => Object.entries(tokens).find(([n, t]) => addr(t.campaign ?? 1000 + Number(n)).toLowerCase() === a.toLowerCase());
  const view = (c: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    if (c.address === FACTORY && c.functionName === "campaignCount") return BigInt(Object.keys(tokens).length);
    if (c.address === FACTORY && c.functionName === "tokens") return addr(Number(Object.keys(tokens)[Number(c.args![0])]));
    if (c.address === FACTORY && c.functionName === "campaignOf") {
      const t = byToken(c.args![0] as string);
      return [t && t[1].campaign !== 0 ? addr(t[1].campaign ?? 1000 + Number(t[0])) : ZERO, ZERO, ZERO, 0n];
    }
    const t = byToken(c.address);
    if (t) {
      if (c.functionName === "symbol") return t[1].symbol;
      if (c.functionName === "name") return `${t[1].symbol} token`;
      if (c.functionName === "balanceOf") return 0n;
    }
    const k = byCampaign(c.address);
    if (k) {
      const v = k[1];
      const values: Record<string, unknown> = {
        opened: true, start: 0n, end: v.end ?? 2_000n, status: v.status ?? 0, minedTotal: 0n, miningReserve: 10n ** 24n,
        capTokens: 10n ** 22n, rewardPerProof: 10n ** 22n, proofFee: 10n ** 14n, minedOf: v.mined ?? 0n, claimable: 0n, token: addr(Number(k[0])),
      };
      if (c.functionName in values) return values[c.functionName];
    }
    throw new Error(`unexpected ${c.functionName} on ${c.address}`);
  };
  const call = (c: never) => {
    try {
      return { status: "success", result: view(c) };
    } catch (error) {
      return { status: "failure", error };
    }
  };
  return {
    getBlock: async () => ({ number: 1n, timestamp: 1_000n }),
    readContract: async (c: never) => view(c),
    multicall: async ({ contracts, allowFailure }: { contracts: never[]; allowFailure: boolean }) =>
      allowFailure ? contracts.map(call) : contracts.map((c) => view(c)),
  } as unknown as PublicClient;
}

test("describeTokens drops tokens the factory did not make and reads names from the chain", async () => {
  const c = chain({ 1: { symbol: "GOOD" }, 2: { symbol: "FAKE", campaign: 0 } });
  const list = await describeTokens(c, config, [addr(1), addr(2), addr(3)]);
  assert.deepEqual(list.map((t) => [t.token, t.symbol]), [[addr(1), "GOOD"]]);
});

const noIndexer = { ...config, indexerUrl: null } as NetworkConfig;

test("one token per symbol resolves directly; an unknown symbol is refused", async () => {
  const c = chain({ 1: { symbol: "TEST1" }, 2: { symbol: "OTHER" } });
  assert.deepEqual(await resolveToken(c, noIndexer, "test1"), { token: addr(1), campaign: addr(1001) });
  await assert.rejects(resolveToken(c, noIndexer, "NOPE"), /No Launchpad mining token called "NOPE"/);
});

test("two tokens with one symbol: start picks the one mining now", async () => {
  const c = chain({ 1: { symbol: "TWIN", status: 1 }, 2: { symbol: "TWIN" } });
  assert.deepEqual(await resolveToken(c, noIndexer, "TWIN", { purpose: "mine" }), { token: addr(2), campaign: addr(1002) });
});

test("two tokens with one symbol: claim and send pick the one this wallet mined", async () => {
  const c = chain({ 1: { symbol: "TWIN", status: 1, mined: 10n ** 22n }, 2: { symbol: "TWIN" } });
  assert.deepEqual(await resolveToken(c, noIndexer, "TWIN", { purpose: "hold", wallet: WALLET }), { token: addr(1), campaign: addr(1001) });
});

test("two tokens with one symbol and nothing to tell them apart: the CLI lists both and asks for the address", async () => {
  const c = chain({ 1: { symbol: "TWIN" }, 2: { symbol: "TWIN" } });
  await assert.rejects(resolveToken(c, noIndexer, "TWIN", { purpose: "mine" }), (e: Error) => e.message.includes(addr(1)) && e.message.includes(addr(2)) && /by address/.test(e.message));
  // the one this wallet used before wins for status
  assert.deepEqual(await resolveToken(c, noIndexer, "TWIN", { purpose: "view", known: [addr(2)] }), { token: addr(2), campaign: addr(1002) });
});

test("a symbol found nowhere else is looked up on the chain (a launched token, off the mining list)", async () => {
  const c = chain({ 1: { symbol: "DONE", status: 1 } });
  const listed = { ...config, indexerUrl: "https://indexer.test" } as NetworkConfig;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ rows: [], next: 0 }))) as typeof fetch;
  try {
    assert.deepEqual(await resolveToken(c, listed, "DONE", { purpose: "hold", wallet: WALLET }), { token: addr(1), campaign: addr(1001) });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(await resolveToken(c, noIndexer, "DONE", { purpose: "hold", wallet: WALLET }), { token: addr(1), campaign: addr(1001) });
});

test("an address the factory does not know is refused", async () => {
  const c = chain({ 1: { symbol: "GOOD" } });
  (c as unknown as { readContract: (x: { functionName: string; address: string; args?: unknown[] }) => Promise<unknown> }).readContract = async (x) => {
    if (x.functionName === "campaignOf") return [ZERO, ZERO, ZERO, 0n];
    throw new Error("not a campaign");
  };
  await assert.rejects(resolveToken(c, noIndexer, addr(9)), /is not a Launchpad mining token/);
});
