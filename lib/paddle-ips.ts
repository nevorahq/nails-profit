import { z } from "zod";

/**
 * Paddle sends webhooks from a small, published set of IPv4 addresses
 * (https://api.paddle.com/ips — the addresses live in `data.ipv4_cidrs`). The
 * list is Paddle's to change, so it is fetched at runtime and cached rather
 * than checked in: a committed list would start rejecting real deliveries the
 * day Paddle adds an address, and nobody would know until a subscription event
 * went missing.
 *
 * This module only fetches, validates and caches. `lib/ip-allowlist.ts` does
 * the matching; the webhook route calls `getPaddleIpAllowlist()`. Tests pass
 * their own `fetchImpl` and clock so nothing here reaches the network under
 * `npm test`.
 */
const PADDLE_IPS_ENDPOINT = "https://api.paddle.com/ips";

/**
 * Long enough that a busy endpoint refetches rarely (a cold serverless
 * container pays for one GET, then nothing for an hour), short enough that a
 * real change to Paddle's addresses is picked up the same day with no deploy.
 */
const TTL_MS = 60 * 60 * 1000;

/** A stalled endpoint must not stall webhook processing — Paddle wants a fast 200. */
const FETCH_TIMEOUT_MS = 2_500;

const responseSchema = z.object({
  data: z.object({
    ipv4_cidrs: z.array(z.string().min(7)).min(1),
  }),
});

type CachedAllowlist = { cidrs: readonly string[]; fetchedAt: number };

let cache: CachedAllowlist | null = null;
let inflight: Promise<readonly string[] | null> | null = null;

async function fetchAllowlist(fetchImpl: typeof fetch): Promise<readonly string[]> {
  const response = await fetchImpl(PADDLE_IPS_ENDPOINT, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Paddle IPs endpoint returned ${response.status}`);
  }
  return responseSchema.parse(await response.json()).data.ipv4_cidrs;
}

/**
 * Paddle's current webhook IP allowlist, or `null` when it has never been
 * fetched successfully and cannot be right now.
 *
 * `null` means "cannot tell", not "allow nothing": the caller keeps the
 * signature check as the hard gate rather than rejecting every webhook during a
 * Paddle-side outage of this one endpoint. A stale cache is always preferred
 * over `null` — an address Paddle removed is a smaller problem than dropping
 * every delivery.
 */
export async function getPaddleIpAllowlist(
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<readonly string[] | null> {
  const { fetchImpl = fetch, now = Date.now() } = options;

  if (cache && now - cache.fetchedAt < TTL_MS) return cache.cidrs;
  if (inflight) return inflight;

  inflight = fetchAllowlist(fetchImpl)
    .then((cidrs): readonly string[] | null => {
      cache = { cidrs, fetchedAt: now };
      return cidrs;
    })
    .catch((): readonly string[] | null => cache?.cidrs ?? null)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Test seam — the module cache is process-wide and outlives a single test. */
export function resetPaddleIpAllowlistCache(): void {
  cache = null;
  inflight = null;
}
