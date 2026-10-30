import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REGISTRY_LATEST_URL, checkForUpdate, classify, compareVersions } from "../src/update.ts";

const V7 = "0x854F44824ff35aF76E6cd5030d1BbfD49414Ba26";
const V8 = "0x1111111111111111111111111111111111111111";
const here = { version: "0.3.0", chainId: 84532, launchpad: V7 };

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("0.2.3", "0.2.3"), 0);
  assert.equal(compareVersions("0.2.2", "0.3.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), 0);
});

test("same or older latest is current", () => {
  assert.deepEqual(classify({ version: "0.3.0", b20minerDeployment: { chainId: 84532, launchpad: V8 } }, here), { kind: "current" });
  // registry still on an older release (e.g. right before publishing)
  assert.deepEqual(classify({ version: "0.2.3" }, here), { kind: "current" });
});

test("a newer CLI for the same deployment is only a suggestion", () => {
  assert.deepEqual(classify({ version: "0.3.1", b20minerDeployment: { chainId: 84532, launchpad: V7.toLowerCase() } }, here), {
    kind: "newer",
    latest: "0.3.1",
  });
  // releases from before the field existed say nothing about the deployment
  assert.deepEqual(classify({ version: "0.3.1" }, here), { kind: "newer", latest: "0.3.1" });
});

test("a newer CLI for a different Launchpad marks this copy retired", () => {
  assert.deepEqual(classify({ version: "0.4.0", b20minerDeployment: { chainId: 84532, launchpad: V8, b20Mining: V8 } }, here), {
    kind: "retired",
    latest: "0.4.0",
    latestLaunchpad: V8,
  });
  // a manifest with only the old field still counts
  assert.equal(classify({ version: "0.4.0", b20minerDeployment: { chainId: 84532, b20Mining: V8 } }, here).kind, "retired");
});

test("0.3.0's manifest retires every 0.2.x copy (they compare b20Mining)", () => {
  const old = { version: "0.2.3", chainId: 84532, launchpad: "0x854F44824ff35aF76E6cd5030d1BbfD49414Ba26" };
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(classify({ version: pkg.version, b20minerDeployment: pkg.b20minerDeployment }, old).kind, "retired");
  assert.equal(pkg.b20minerDeployment.b20Mining, pkg.b20minerDeployment.launchpad);
});

test("odd registry replies never block mining", () => {
  for (const m of [null, "x", {}, { version: 3 }, { version: "latest" }]) assert.deepEqual(classify(m, here), { kind: "unknown" });
  // another chain or a malformed address: not evidence this deployment is retired
  assert.equal(classify({ version: "0.4.0", b20minerDeployment: { chainId: 8453, launchpad: V8 } }, here).kind, "newer");
  assert.equal(classify({ version: "0.4.0", b20minerDeployment: { chainId: 84532, launchpad: "0x12" } }, here).kind, "newer");
});

test("the check asks the registry's latest manifest and fails open", async () => {
  const seen: string[] = [];
  const reply = (body: unknown, status = 200) =>
    (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  assert.equal((await checkForUpdate(reply({ version: "0.0.1" }))).kind, "current");
  assert.equal(seen[0], REGISTRY_LATEST_URL);
  assert.equal((await checkForUpdate(reply({}, 503))).kind, "unknown");
  assert.equal((await checkForUpdate((async () => { throw new TypeError("offline"); }) as typeof fetch)).kind, "unknown");

  process.env.B20MINER_NO_UPDATE_CHECK = "1";
  try {
    seen.length = 0;
    assert.equal((await checkForUpdate(reply({ version: "9.9.9" }))).kind, "unknown");
    assert.equal(seen.length, 0, "no request when the check is switched off");
  } finally {
    delete process.env.B20MINER_NO_UPDATE_CHECK;
  }
});
