import { DEPLOYMENT } from "./deployment.ts";
import { VERSION } from "./config.ts";

/**
 * Update check against the npm registry. Every published package.json
 * carries `b20minerDeployment` (written by scripts/sync.mjs), so the
 * registry's `latest` manifest says which Launchpad factory the newest CLI
 * mines (`launchpad`; releases up to 0.2.x named their B20Mining as
 * `b20Mining`). If that differs from the one built into this CLI, this copy
 * is mining a retired deployment and `start` refuses to spend ETH on it.
 *
 * The check only ever warns or refuses; it never changes the contract this
 * CLI talks to. It fails open (offline, slow registry, odd reply) and is
 * skipped with B20MINER_NO_UPDATE_CHECK=1.
 */

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/b20miner/latest";
const TIMEOUT_MS = 3_000;

export type UpdateCheck =
  | { readonly kind: "current" }
  /** A newer CLI exists for the same deployment: worth updating, mining still counts. */
  | { readonly kind: "newer"; readonly latest: string }
  /** The newest CLI mines a different Launchpad: this copy's tokens are retired. */
  | { readonly kind: "retired"; readonly latest: string; readonly latestLaunchpad: string }
  /** Skipped or the registry could not be read. */
  | { readonly kind: "unknown" };

/** Compares x.y.z versions numerically; pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

interface Current {
  readonly version: string;
  readonly chainId: number;
  readonly launchpad: string;
}

const THIS_CLI: Current = { version: VERSION, chainId: DEPLOYMENT.chainId, launchpad: DEPLOYMENT.launchpadFactory };

/** Classifies the registry's `latest` manifest against this CLI. */
export function classify(manifest: unknown, current: Current = THIS_CLI): UpdateCheck {
  if (typeof manifest !== "object" || manifest === null) return { kind: "unknown" };
  const m = manifest as { version?: unknown; b20minerDeployment?: { chainId?: unknown; launchpad?: unknown; b20Mining?: unknown } };
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) return { kind: "unknown" };
  if (compareVersions(m.version, current.version) <= 0) return { kind: "current" };
  const d = m.b20minerDeployment;
  // A release from before 0.3 names only its B20Mining: a different contract kind, so a retired one.
  const theirs = d ? (d.launchpad ?? d.b20Mining) : undefined;
  if (
    d &&
    d.chainId === current.chainId &&
    typeof theirs === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(theirs) &&
    theirs.toLowerCase() !== current.launchpad.toLowerCase()
  ) {
    return { kind: "retired", latest: m.version, latestLaunchpad: theirs };
  }
  return { kind: "newer", latest: m.version };
}

export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  if (process.env.B20MINER_NO_UPDATE_CHECK === "1") return { kind: "unknown" };
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "unknown" };
    return classify(await res.json());
  } catch {
    return { kind: "unknown" };
  }
}

export const UPDATE_COMMAND = "npm install -g b20miner@latest";
