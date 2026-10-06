import { z } from "zod";

import { getPaddleApiConfig } from "@/env";

/**
 * The narrow slice of Paddle's server API the app needs today: reading a
 * subscription so the settings page can show a "manage" link, and reading the
 * price that checkout opens so the button can say what it costs.
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

const priceSchema = z.object({
  data: z.object({
    name: z.string().nullish(),
    unit_price: z.object({ amount: z.string(), currency_code: z.string() }),
    billing_cycle: z
      .object({ interval: z.enum(["day", "week", "month", "year"]), frequency: z.number() })
      .nullish(),
    product: z.object({ name: z.string().nullish() }).nullish(),
  }),
});

export type PaddlePlan = Readonly<{
  /** The product's name as the studio set it up in Paddle, e.g. «Студия». */
  name: string | null;
  amountMinor: number;
  currency: string;
  /** Null for a one-off price, and for a cycle of more than one unit («every 3 months»). */
  interval: "day" | "week" | "month" | "year" | null;
}>;

/**
 * What the checkout's price is called and costs, read from Paddle rather than
 * written into the app: the tariff grid is still being decided, and a price
 * typed here would be one more place to change. Best-effort like the rest —
 * `null` and the button simply carries no price.
 */
export async function fetchPaddlePlan(
  priceId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PaddlePlan | null> {
  const config = getPaddleApiConfig();
  if (!config) return null;
  const { fetchImpl = fetch } = options;

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/prices/${encodeURIComponent(priceId)}?include=product`,
      {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
        next: { revalidate: 3_600 },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const { data } = priceSchema.parse(await response.json());
    const amountMinor = Number(data.unit_price.amount);
    if (!Number.isSafeInteger(amountMinor)) return null;
    return {
      name: data.product?.name ?? data.name ?? null,
      amountMinor,
      currency: data.unit_price.currency_code,
      interval: data.billing_cycle?.frequency === 1 ? data.billing_cycle.interval : null,
    };
  } catch {
    return null;
  }
}
