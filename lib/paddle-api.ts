import { z } from "zod";

import { getPaddleApiConfig } from "@/env";

/**
 * The narrow slice of Paddle's server API the app needs today: reading a
 * subscription so the settings page can show a "manage" link.
 *
 * Paddle's `subscription.*` webhooks don't include `management_urls` (confirmed
 * against sandbox — see `lib/paddle-webhook.ts`), but the subscription resource
 * does. Those links are short-lived signed URLs, so they're fetched when the
 * page renders rather than stored.
 *
 * Everything here is best-effort: an unset `PADDLE_API_KEY`, a slow endpoint, a
 * non-2xx response or an unexpected shape all resolve to `null`, and the caller
 * renders as if there were no link. `fetchImpl` is injectable for tests.
 */
const FETCH_TIMEOUT_MS = 4_000;

const subscriptionSchema = z.object({
  data: z.object({
    management_urls: z
      .object({
        update_payment_method: z.string().nullish(),
        cancel: z.string().nullish(),
      })
      .nullish(),
  }),
});

/**
 * The customer-portal link for a Paddle subscription — `update_payment_method`
 * if present, otherwise `cancel`, otherwise `null`.
 */
export async function fetchPaddleSubscriptionManageUrl(
  subscriptionId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const config = getPaddleApiConfig();
  if (!config) return null;
  const { fetchImpl = fetch } = options;

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const urls = subscriptionSchema.parse(await response.json()).data.management_urls;
    return urls?.update_payment_method ?? urls?.cancel ?? null;
  } catch {
    return null;
  }
}
