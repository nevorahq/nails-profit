# Paddle billing — sandbox build & live migration

Living record of the Paddle catalog and the sandbox → live ID mapping. Built
from scratch (no prior sandbox integration existed). Approved tariffs: the
Oct 2026 grid in `domain/plans.ts` — free Start, then Solo/Studio/Business at
€9/€19/€39 a month, one price for every country, with 6 months charged as 5 and
12 as 9. The Aug 2026 grid (€17/29/59 × 1/3/6) is archived in sandbox and still
active in live.

## Product

| | Sandbox | Live |
| --- | --- | --- |
| id | `pro_01m1f4nqcrnpasdsp21bfayxrr` | `pro_01m0jr96ar4zdg1pf1ybvddecy` |
| name (shown at checkout) | `nailsprofit` | `nevora nails-profit` |
| tax category | `saas` | `saas` (was `standard` — updated in place, no prices/subs attached at the time) |

One product, 9 recurring prices. The app keys off the **price** id, not the
product, so a later split into per-tier products would only mean recreating
prices.

## Prices

### October grid (current)

All: `billing_cycle` interval `month`, frequency = period; **no Paddle trial**
(the 14-day Studio trial runs in the app, before checkout); base currency EUR;
`tax_mode` `location` — the amount includes VAT where Paddle charges it (B2C in
Moldova: €9 is €7.50 + €1.50 VAT). The app maps price ids in
`lib/paddle-catalog.ts`; the amounts must match `domain/plans.ts`.

Plan prices — `quantity` 1–1, `custom_data` `{ tier, period_months }`:

| Tier | Period | Amount | Sandbox price id | Live price id |
| --- | --- | --- | --- | --- |
| Solo | monthly | €9.00 | `pri_01m4zfy4kmaqvb7yeehndg6dg5` | — |
| Solo | 6 months | €45.00 | `pri_01m4zfy4ssqw1e5cxjhq0txbnh` | — |
| Solo | 12 months | €81.00 | `pri_01m4zfy4z47ept293pzaza7v72` | — |
| Studio | monthly | €19.00 | `pri_01m4zfy545j0c13nwewzq7apc6` | — |
| Studio | 6 months | €95.00 | `pri_01m4zfy599jm1neh74ysqhc8mf` | — |
| Studio | 12 months | €171.00 | `pri_01m4zfy5eacyjd4jndvqy3t3xk` | — |
| Business | monthly | €39.00 | `pri_01m4zfy5kebm2fdmt1bnqzcjan` | — |
| Business | 6 months | €195.00 | `pri_01m4zfy5rrqxats5ypg6n8n0r2` | — |
| Business | 12 months | €351.00 | `pri_01m4zfy5y2zxfe90gdreqc5r55` | — |

Add-on prices — `quantity` 1–100, `custom_data` `{ addon, tier, period_months }`.
Created, not yet used by the app (seat counting comes with plan limits):

| Add-on | monthly | 6 months | 12 months |
| --- | --- | --- | --- |
| Studio: specialist beyond 3 (€4) | `pri_01m4zfy6326ahd15s96zjae46r` | `pri_01m4zfy684q3aa53y4zz7757ty` | `pri_01m4zfy6dcwmb215hzmx2rjkgp` |
| Business: specialist beyond 8 (€3) | `pri_01m4zfy6jfm6z5y7pvn1k9dh9x` | `pri_01m4zfy721z49rtg2z0bzj6ca6` | `pri_01m4zfy774mbdkpnrz7kx3zb2g` |
| Business: location beyond 3 (€10) | `pri_01m4zfy7bzyar3508vxbt25hfm` | `pri_01m4zfy7vh1bp6mktcn50wjc1y` | `pri_01m4zfy80gaysd8xxfjaq8xmv6` |

### Founder discount

| | Sandbox | Live |
| --- | --- | --- |
| id | `dsc_01m4zfy9jq1adcmdxw0q6vn2wt` | — |
| code | `FOUNDER30` | — |
| terms | −30%, `recur: true`, `maximum_recurring_intervals: null` (forever), `usage_limit: 100`, restricted to the 18 October prices | |

Checked with `pricingPreview` (MD address): Business 12 months €351 → €245.70;
Solo monthly €9 → €6.30. Paddle counts redemptions at completed checkouts, so
two checkouts open at the hundredth seat can both pass; unset
`NEXT_PUBLIC_PADDLE_DISCOUNT_CODE` once `times_used` reaches 100.

### August grid (archived in sandbox, active in live)

Same structure with a 7-day cardless Paddle trial. Sandbox ids archived
2026-10-15; live ids below are to be archived when the live October catalog is
created.

| Tier | Period | Amount | Sandbox (archived) | Live |
| --- | --- | --- | --- | --- |
| Solo | monthly | €17.00 | `pri_01m1f59x9xj6dqjr83k9ch37gq` | `pri_01m1faf7x95662ycy6pmfze4nb` |
| Solo | 3 months | €46.00 | `pri_01m1f59xg46469jgmv289rwqft` | `pri_01m1faf820hm4zk1jb76y3xz93` |
| Solo | 6 months | €89.00 | `pri_01m1f59y18ycjndxcrde31c6e6` | `pri_01m1faf86ht61b9995rr95rxrv` |
| Studio | monthly | €29.00 | `pri_01m1f59y75gq0krywss3thsmhf` | `pri_01m1faf8be4d3gs18jd34915py` |
| Studio | 3 months | €76.00 | `pri_01m1f59yqgwr91k3ymyxv1w9e6` | `pri_01m1faf8g5q4ge7rett0txe4qd` |
| Studio | 6 months | €149.00 | `pri_01m1f59ywp1wf819g2xf8jkpq8` | `pri_01m1faf8ngeca09hkd9t0td6ag` |
| Business | monthly | €59.00 | `pri_01m1f59z1td2capxr7v040a3p1` | `pri_01m1faf8t3z2ad77p3dt04t035` |
| Business | 3 months | €156.00 | `pri_01m1f59z77rrqcfxyjrsg36pgz` | `pri_01m1faf8ysvezt8c267d7pa6bf` |
| Business | 6 months | €299.00 | `pri_01m1f59zcasg1fz3f7s713tbtj` | `pri_01m1faf93frp5ezdehs9ap2zd5` |

## Client-side token (Paddle.js checkout init)

| | Sandbox | Live |
| --- | --- | --- |
| id | `ctkn_01m1f5a5b2vqwvmsbqq7zrcfjj` | `ctkn_01m1fafsk0mqqj6d27568qaazj` |
| token (`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`) | `test_23216d3863dd1a93f6829435c2d` | `live_e796ae904096bb9100b29107445` |

Public value — safe in the browser bundle (ships to every checkout page).

## Notification destination (webhook)

| | Sandbox | Live |
| --- | --- | --- |
| id | `ntfset_01m1f6bjt71528kq24abdy8ftt` | `ntfset_01m1fafssd8t7rev6nw731cpgb` |
| destination URL | `https://phrases-finding-hammer-lambda.trycloudflare.com/api/v1/webhooks/paddle` (ephemeral quick tunnel) | `https://nailsprofit.nevorahq.com/api/v1/webhooks/paddle` |
| `endpoint_secret_key` → `PADDLE_WEBHOOK_SECRET` | in local `.env` (not committed) | handed to the account owner once → Netlify env (not committed) |
| subscribed events | 8 × `subscription.*` | 8 × `subscription.*` |
| traffic_source | `all` (real + simulations) | `platform` |
| include_sensitive_fields | `true` (test) | `false` |

Live destination is **create-once**: recreating rotates `endpoint_secret_key`
and breaks delivery verification. Reuse an existing one; never delete. The
route at that URL is not deployed yet — Paddle will 404 and retry; there are no
live subscription events until verification and domain approval pass anyway.

## Env var mapping

| Var | Sandbox value (local `.env`) | Live value (Netlify) |
| --- | --- | --- |
| `NEXT_PUBLIC_PADDLE_ENVIRONMENT` | `sandbox` | `live` (or unset) |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | `test_23216d3863dd1a93f6829435c2d` | `live_e796ae904096bb9100b29107445` |
| `NEXT_PUBLIC_PADDLE_DISCOUNT_CODE` | `FOUNDER30` | `FOUNDER30` once the live discount exists; unset at 100 redemptions |
| `PADDLE_WEBHOOK_SECRET` | sandbox `endpoint_secret_key` | live `endpoint_secret_key` (from destination `ntfset_01m1fafssd8t7rev6nw731cpgb`) |
| `PADDLE_API_KEY` | `pdl_sdbx_…` | `pdl_live_…` (the MCP key; needs `subscription.read` for the manage-link fetch) |
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

## Live catalog replicated (2026-09-01)

Live account was near-empty (1 product, 0 prices/discounts/webhooks, **0
subscriptions**). Replicated additively via the `paddle-live` MCP:
- Product `pro_01m0jr96ar4zdg1pf1ybvddecy` tax category `standard` → `saas` (update in place).
- 9 prices — identical structure/amounts/trial to sandbox.
- Client token `ctkn_01m1fafsk0mqqj6d27568qaazj`.
- Notification destination `ntfset_01m1fafssd8t7rev6nw731cpgb` (the account had
  none). `endpoint_secret_key` read once, handed off for Netlify.

Nothing deleted, archived or recreated.

## Going live with the October grid

In this order — each step is safe on its own, and the limits come last, once a
studio can pay its way past them.

1. **Live catalog** (not done: the Paddle live account was not written to from
   the coding session). Create the 9 plan prices, the 9 add-on prices and the
   `FOUNDER30` discount exactly as in sandbox (same names, amounts,
   `custom_data`, no trial; the discount restricted to the 18 new prices), then
   fill `live` in `lib/paddle-catalog.ts` and the live column above. The August
   live prices stay **active** for now: production still runs the old build,
   whose button opens `pri_01m1faf7x95662ycy6pmfze4nb` through
   `NEXT_PUBLIC_PADDLE_PRICE_ID`.
2. **Merge and publish** the three branches (reprice → limits → pilots), then
   publish the deploy by hand — production publishing is manual.
3. **Netlify, production context:** unset `NEXT_PUBLIC_PADDLE_PRICE_ID` (the
   build no longer reads it); set `NEXT_PUBLIC_PADDLE_DISCOUNT_CODE=FOUNDER30`;
   set `PILOT_FREE_UNTIL` to the last free day for pilots, three months from
   the day billing goes live.
4. **Archive the 9 August live prices** — only now, once nothing opens them.
5. **Turn the limits on:** `PLAN_LIMITS_ENFORCEMENT=true`. Studios older than
   14 days without a subscription or an open pilot move to Start the moment it
   is set; they lose nothing they have, only what Start does not include.
6. Watch `FOUNDER30`'s `times_used`; unset `NEXT_PUBLIC_PADDLE_DISCOUNT_CODE`
   at 100.

`SUBSCRIPTION_ACCESS_ENFORCEMENT` is gone: with a free Start a studio without a
subscription is never locked out. It was never set in production.

## Still to do for live

- **Netlify env vars** — see the mapping table above. Nothing lands until they're set.
- **Live October catalog** — step 1 above. Until it exists the settings page
  draws no checkout when `NEXT_PUBLIC_PADDLE_ENVIRONMENT` is live.
- **The API host follows the environment**: `getPaddleApiConfig` switches it on
  `NEXT_PUBLIC_PADDLE_ENVIRONMENT`, and the price ids are picked per environment
  in `lib/paddle-catalog.ts`.
- **Deploy** — the webhook route (`app/api/v1/webhooks/paddle`) isn't on
  `nailsprofit.nevorahq.com` yet.
- `pwCustomer: { id: 'ctm_…' }` in `Paddle.Initialize()` for Retain, once the
  signed-in customer has a Paddle customer id.
- Server-side Paddle API client for upgrade/downgrade/cancel (extends `lib/paddle-api.ts`).
- Dashboard (live): payment methods, default payment link, submit
  `nailsprofit.nevorahq.com` for domain approval, bank/payout details.
