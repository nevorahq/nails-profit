/**
 * IPv4 allowlist matching for webhook origin checks.
 *
 * Paddle publishes the addresses its webhooks come from as a list of IPv4 /32
 * CIDRs (https://api.paddle.com/ips). `lib/paddle-ips.ts` fetches and caches
 * that list; this module answers whether a given caller is on it. The two are
 * separate so the matching stays pure and the fetch layer is the only thing
 * that touches the network — the same split `lib/preview.ts` draws between
 * parsing and its browser wrapper.
 *
 * IPv4 only, deliberately: Paddle's endpoint returns `ipv4_cidrs` and nothing
 * else, so an IPv6 caller cannot be on the list and `matchesCidr` returns
 * `false` for one rather than guessing.
 */

/**
 * The caller's address as the platform reports it. `x-nf-client-connection-ip`
 * is what Netlify sets to the real client address and cannot be spoofed by the
 * client; `x-forwarded-for` is the generic fallback, whose first hop is the
 * original client. `null` when neither header is present (local `next dev`).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const netlify = headers.get("x-nf-client-connection-ip")?.trim();
  if (netlify) return netlify;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

/**
 * `192.0.2.1` unchanged; `192.0.2.1` from `::ffff:192.0.2.1` (an IPv4-mapped
 * IPv6 address) or `192.0.2.1%eth0` (with a zone id); `null` for a real IPv6
 * address or anything that is not four 0–255 octets.
 */
export function normalizeIpv4(value: string): string | null {
  let ip = value.trim();

  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);

  // Strip an `::ffff:` / `::` prefix: the IPv4 part is everything after the
  // last colon. A hex-form mapped address (`::ffff:c000:0201`) has no dotted
  // tail and falls through to the octet check below, which rejects it.
  const lastColon = ip.lastIndexOf(":");
  if (lastColon >= 0) ip = ip.slice(lastColon + 1);

  const octets = ip.split(".");
  if (octets.length !== 4) return null;

  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) return null;
  }
  return octets.map((octet) => String(Number(octet))).join(".");
}

function ipv4ToInt(ip: string): number | null {
  const normalized = normalizeIpv4(ip);
  if (!normalized) return null;
  let result = 0;
  for (const octet of normalized.split(".")) {
    result = (result << 8) | Number(octet);
  }
  return result >>> 0;
}

/**
 * Whether `ip` falls inside `cidr` (e.g. `34.194.127.46/32`, or a bare address
 * treated as `/32`). `false` for a malformed CIDR, a non-IPv4 `ip`, or a prefix
 * length outside 0–32 — a check that only ever denies has no reason to throw.
 */
export function matchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const rangePart = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const bits = slash >= 0 ? Number(cidr.slice(slash + 1)) : 32;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(rangePart);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;

  // `-1 << 32` is `-1` in JS (the shift count wraps), so /32 is its own case.
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((rangeInt & mask) >>> 0);
}

/** Whether `ip` matches any entry in `cidrs`. */
export function ipInAllowlist(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => matchesCidr(ip, cidr));
}
