# Paddle billing — sandbox build & live migration

Living record of the Paddle catalog and the sandbox → live ID mapping. Built
from scratch (no prior sandbox integration existed). Approved tariffs: see the
Aug 2026 pricing decision (Solo/Studio/Business × 1/3/6-month prepay, EUR).

## Product

| Entity | Sandbox | Live |
| --- | --- | --- |
| Product `nailsprofit` (tax category `saas`) | `pro_01m1f4nqcrnpasdsp21bfayxrr` | _pending_ |

One product, 9 recurring prices. The app keys off the **price** id, not the
product, so a later split into per-tier products would only mean recreating
prices.

## Prices

All: `billing_cycle` interval `month`; 7-day cardless trial
(`trial_period` day/7, `requires_payment_method: false`); `quantity` 1–1;
`custom_data` `{ tier, period_months }`; base currency EUR.

| Tier | Period | Amount | `custom_data` | Sandbox price id | Live price id |
| --- | --- | --- | --- | --- | --- |
| Solo | monthly | €17.00 | `{solo,1}` | `pri_01m1f59x9xj6dqjr83k9ch37gq` | _pending_ |
| Solo | 3 months | €46.00 | `{solo,3}` | `pri_01m1f59xg46469jgmv289rwqft` | _pending_ |
| Solo | 6 months | €89.00 | `{solo,6}` | `pri_01m1f59y18ycjndxcrde31c6e6` | _pending_ |
| Studio | monthly | €29.00 | `{studio,1}` | `pri_01m1f59y75gq0krywss3thsmhf` | _pending_ |
| Studio | 3 months | €76.00 | `{studio,3}` | `pri_01m1f59yqgwr91k3ymyxv1w9e6` | _pending_ |
| Studio | 6 months | €149.00 | `{studio,6}` | `pri_01m1f59ywp1wf819g2xf8jkpq8` | _pending_ |
| Business | monthly | €59.00 | `{business,1}` | `pri_01m1f59z1td2capxr7v040a3p1` | _pending_ |
| Business | 3 months | €156.00 | `{business,3}` | `pri_01m1f59z77rrqcfxyjrsg36pgz` | _pending_ |
| Business | 6 months | €299.00 | `{business,6}` | `pri_01m1f59zcasg1fz3f7s713tbtj` | _pending_ |

Not built yet: per-seat add-on prices (+€7/master Studio; +€5/master +€15/address
Business), launch discount codes.

## Client-side token (Paddle.js checkout init)

| | Sandbox | Live |
| --- | --- | --- |
| id | `ctkn_01m1f5a5b2vqwvmsbqq7zrcfjj` | _pending_ |
| token (`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`) | `test_23216d3863dd1a93f6829435c2d` | _pending_ (`live_…`) |

Public value — safe in the browser bundle.

## Notification destination (webhook)

| | Sandbox | Live |
| --- | --- | --- |
| id | `ntfset_01m1f6bjt71528kq24abdy8ftt` | _pending_ |
| destination URL | `https://phrases-finding-hammer-lambda.trycloudflare.com/api/v1/webhooks/paddle` (ephemeral quick tunnel) | `https://<approved-domain>/api/v1/webhooks/paddle` |
| `endpoint_secret_key` → `PADDLE_WEBHOOK_SECRET` | in local `.env` (not committed) | _pending_ |
| subscribed events | 8 × `subscription.*` | `subscription.*` |
| traffic_source | `all` (real + simulations) | `platform` |

Live destination is **create-once**: recreating rotates `endpoint_secret_key`
and breaks delivery verification. Reuse an existing one; never delete.

## Env var mapping

| Var | Sandbox value | Live value |
| --- | --- | --- |
| `NEXT_PUBLIC_PADDLE_ENVIRONMENT` | `sandbox` | `live` (or unset) |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | `test_23216d3863dd1a93f6829435c2d` | `live_…` |
| `NEXT_PUBLIC_PADDLE_PRICE_ID` | `pri_01m1f59x9xj6dqjr83k9ch37gq` (Solo monthly, test) | live Solo-monthly id |
| `PADDLE_WEBHOOK_SECRET` | sandbox `endpoint_secret_key` | live `endpoint_secret_key` |
| `PADDLE_API_KEY` | `pdl_sdbx_…` | `pdl_live_…` |
| `PADDLE_WEBHOOK_IP_ALLOWLIST` | `false` (tunnel isn't a Paddle IP) | `true` |

## Sandbox validation (2026-09-01)

Dev server on the local `nail_profit_test` DB, webhook reachable via a cloudflared
quick tunnel. `.env` carries the sandbox token / price / `endpoint_secret_key`.

**Validated:**
- Sign-up → onboarding → app on the test DB.
- `getPaddleCheckoutConfig()` renders the checkout button; Paddle.js loads,
  `Paddle.Environment.set('sandbox')` runs only for `NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox`
  (overlay opens on `sandbox-buy.paddle.com`, not prod), `Initialize()` + `Checkout.open()` fire.
- Webhook handler, end-to-end over real HTTP + real signing + real DB writes:
  - Paddle's own signature (vanilla `subscription.activated` simulation) → `200`, not `400`.
  - Forged signature → `400 {received:false}`.
  - `activated` → row created; `past_due` → row updated in place; `canceled` +
    `scheduled_change.action=cancel` → `status=canceled`, `cancel_at_period_end=true`.
  - Duplicate `event_id` → ignored (3 event rows, not 4); `transaction.*` → ignored, still `200`.
  - `custom_data.organization_id` → correct org linkage; `current_period_end`,
    `manage_url` parsed from the payload.

**Real checkout — validated** (2026-09-01, tunnel FQDN approved as checkout domain,
default payment link → tunnel, dev server `BETTER_AUTH_URL`/`NEXT_PUBLIC_APP_URL`
→ tunnel). Sign-up → org → `/app/settings` → checkout overlay (`sandbox-buy.paddle.com`,
Test Mode, "7 day free trial", €0 due today) → sandbox card `4242 4242 4242 4242`
→ "Your transaction has been completed". Result:
- `organization_subscription` row created, `status=trialing`, real `sub_…` / `ctm_…`,
  our price id, `current_period_end` = trial end.
- **`custom_data.organization_id` round-trip CONFIRMED**: the id from
  `Checkout.open({customData})` is in both the `subscription.trialing` and
  `subscription.created` webhook payloads; handler linked the row to the right org.

**Bugs found and fixed (2026-09-01):**
1. **Concurrent-event 500 — FIXED.** Paddle sends `subscription.created` +
   `subscription.trialing` within ms on checkout. `applyBillingEvent`'s
   `onConflictDoUpdate` targets only `(provider, provider_subscription_id)`, but
   `organization_subscription` also has a unique index on `(organization_id)`; the
   second concurrent INSERT hit the other index → `500` → Paddle retried → succeeded
   on retry. Fix: a per-org advisory lock (`pg_advisory_xact_lock(hashtextextended(
   organization_id, 0))`) at the top of `applyBillingEvent`, the same idiom as
   `app/api/v1/organizations/route.ts`. Also: the upsert now `coalesce`s `manage_url`
   so a later event can't wipe a stored link. Regression tests in
   `tests/integration/billing-webhook.test.ts` (a deterministic lock-contention test
   that fails 3/3 without the fix, plus a real concurrent pair). `lib/billing-subscription.ts`.
2. **`management_urls` absent from webhooks — HANDLED.** Confirmed absent from
   `subscription.trialing` / `subscription.created`; present on the subscription
   resource. New `lib/paddle-api.ts` `fetchPaddleSubscriptionManageUrl()` (server-side,
   `PADDLE_API_KEY`, base host from `NEXT_PUBLIC_PADDLE_ENVIRONMENT`, all failures →
   `null`). `app/app/settings/page.tsx` calls it when a Paddle subscription has no
   stored `manage_url`. Unset key → no request, link hidden — same as before. Unit
   tests in `lib/paddle-api.test.ts`. `lib/paddle-webhook.ts` comment updated.

**Dev-only note:** `next/script` does not inject Paddle.js when the app is served
through the cloudflared tunnel in `next dev` (HMR websocket fails → hydration
incomplete). Not a product bug — a built app is fine. Paddle.js was injected
manually for the test.

## Still code-side before live

- Tier/period picker → checkout with the right price id (today: one hard-wired price).
- Server-side Paddle API client for upgrade/downgrade/cancel (`PADDLE_API_KEY`).
- `pwCustomer: { id: 'ctm_…' }` in `Paddle.Initialize()` for Retain, once the
  signed-in customer has a Paddle customer id.
- `sandbox-api.paddle.com` → `api.paddle.com` in any server-side calls (none yet).
