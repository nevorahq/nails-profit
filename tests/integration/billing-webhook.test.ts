import { createHmac } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { billingProviderEvents, organizationSubscriptions } from "@/db/schema";
import { applyBillingEvent, type NormalizedBillingEvent } from "@/lib/billing-subscription";
import { getPaddleIpAllowlist, resetPaddleIpAllowlistCache } from "@/lib/paddle-ips";
import { POST as postLemonSqueezyWebhook } from "@/app/api/v1/webhooks/lemon-squeezy/route";
import { POST as postPaddleWebhook } from "@/app/api/v1/webhooks/paddle/route";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createOrganization, createUser } from "../helpers/factories";

describe("billing webhook", () => {
  let organizationId: string;

  beforeEach(async () => {
    await resetDatabase();
    const user = await createUser();
    const organization = await createOrganization({ ownerId: user.id, name: "Green Nails" });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  function paddleEvent(overrides: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent {
    return {
      provider: "paddle",
      organizationId,
      providerCustomerId: "ctm_123",
      providerSubscriptionId: "sub_123",
      providerPriceId: "pri_123",
      status: "active",
      currentPeriodEnd: new Date("2026-09-20T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      manageUrl: "https://paddle.example/manage",
      rawEventType: "subscription.activated",
      ...overrides,
    };
  }

  async function subscriptionRows(forOrganizationId = organizationId) {
    return adminDb
      .select()
      .from(organizationSubscriptions)
      .where(eq(organizationSubscriptions.organizationId, forOrganizationId));
  }

  async function eventRows() {
    return adminDb
      .select()
      .from(billingProviderEvents)
      .where(eq(billingProviderEvents.organizationId, organizationId));
  }

  describe("applyBillingEvent", () => {
    test("a new subscription event creates the row", async () => {
      const outcome = await applyBillingEvent(paddleEvent(), "evt_1");
      expect(outcome).toBe("applied");

      const [row] = await subscriptionRows();
      expect(row).toMatchObject({ provider: "paddle", providerSubscriptionId: "sub_123", status: "active" });
      expect(await eventRows()).toHaveLength(1);
    });

    test("a later event for the same subscription updates the row in place", async () => {
      await applyBillingEvent(paddleEvent({ status: "active" }), "evt_1");
      await applyBillingEvent(paddleEvent({ status: "past_due" }), "evt_2");

      const rows = await subscriptionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("past_due");
    });

    test("a later event without a manage url keeps the stored one", async () => {
      await applyBillingEvent(paddleEvent({ manageUrl: "https://portal/x" }), "evt_1");
      await applyBillingEvent(paddleEvent({ manageUrl: null, status: "past_due" }), "evt_2");

      const [row] = await subscriptionRows();
      expect(row?.manageUrl).toBe("https://portal/x");
      expect(row?.status).toBe("past_due");
    });

    test("a resent event is not applied twice", async () => {
      await applyBillingEvent(paddleEvent(), "evt_1");
      const second = await applyBillingEvent(paddleEvent({ status: "canceled" }), "evt_1");

      expect(second).toBe("duplicate");
      const [row] = await subscriptionRows();
      // The duplicate's different status never applied: same event id, so it
      // never reached the subscription upsert at all.
      expect(row?.status).toBe("active");
      expect(await eventRows()).toHaveLength(1);
    });

    test("events for different organizations do not collide", async () => {
      const otherUser = await createUser();
      const other = await createOrganization({ ownerId: otherUser.id, name: "Other Studio" });

      await applyBillingEvent(paddleEvent(), "evt_1");
      await applyBillingEvent(
        paddleEvent({ organizationId: other.id, providerSubscriptionId: "sub_999" }),
        "evt_2",
      );

      const [mine] = await subscriptionRows();
      expect(mine?.providerSubscriptionId).toBe("sub_123");
      const [theirs] = await subscriptionRows(other.id);
      expect(theirs?.providerSubscriptionId).toBe("sub_999");
    });

    /*
     * Regression for the concurrent-checkout race: Paddle sends
     * `subscription.created` and `subscription.trialing` within milliseconds of
     * each other. Both insert the same new `organization_subscription` row, and
     * the loser used to conflict on `organization_subscription_org_idx` — not the
     * upsert's arbiter index — so PostgreSQL threw and the webhook 500'd until
     * Paddle retried. The fix is a per-organization advisory lock in
     * `applyBillingEvent`.
     */
    test("serializes webhook processing per organization", async () => {
      let done = false;
      let pending: Promise<unknown> = Promise.resolve();

      await adminDb.transaction(async (tx) => {
        // Hold the same lock applyBillingEvent takes.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`);
        pending = applyBillingEvent(paddleEvent(), "evt_lock").then(() => {
          done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        // Still blocked: it cannot touch the row while this transaction holds the lock.
        expect(done).toBe(false);
      });

      await pending;
      expect(done).toBe(true);
      expect(await subscriptionRows()).toHaveLength(1);
    });

    test("concurrent events for one new subscription do not collide", async () => {
      const [a, b] = await Promise.all([
        applyBillingEvent(
          paddleEvent({ status: "trialing", rawEventType: "subscription.created" }),
          "evt_concurrent_created",
        ),
        applyBillingEvent(
          paddleEvent({ status: "trialing", rawEventType: "subscription.trialing" }),
          "evt_concurrent_trialing",
        ),
      ]);

      expect([a, b].sort()).toEqual(["applied", "applied"]);
      const rows = await subscriptionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("trialing");
      expect(await eventRows()).toHaveLength(2);
    });
  });

  describe("POST /api/v1/webhooks/paddle", () => {
    const secret = "paddle_test_secret_1234567890";

    afterEach(() => {
      delete process.env.PADDLE_WEBHOOK_SECRET;
      delete process.env.PADDLE_WEBHOOK_IP_ALLOWLIST;
      resetPaddleIpAllowlistCache();
      vi.unstubAllGlobals();
    });

    function request(body: string, ts: string, secretForSignature = secret, ip?: string) {
      const h1 = createHmac("sha256", secretForSignature).update(`${ts}:${body}`).digest("hex");
      const headers: Record<string, string> = { "paddle-signature": `ts=${ts};h1=${h1}` };
      if (ip) headers["x-nf-client-connection-ip"] = ip;
      return new Request("https://example.com/api/v1/webhooks/paddle", {
        method: "POST",
        headers,
        body,
      });
    }

    const ALLOWED_IP = "34.194.127.46";

    /**
     * Warm the process-wide allowlist cache from a fake response so the route's
     * own `getPaddleIpAllowlist()` call is served from cache and never reaches
     * the network under test.
     */
    async function primeAllowlist(cidrs: string[] = [`${ALLOWED_IP}/32`]) {
      await getPaddleIpAllowlist({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ data: { ipv4_cidrs: cidrs } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      });
    }

    function signedEvent(eventId: string) {
      return JSON.stringify({
        event_id: eventId,
        event_type: "subscription.activated",
        data: {
          id: `sub_${eventId}`,
          customer_id: "ctm_abc",
          status: "active",
          current_billing_period: { ends_at: "2026-09-20T00:00:00.000Z" },
          items: [{ price: { id: "pri_abc" } }],
          custom_data: { organization_id: organizationId },
        },
      });
    }

    test("404s when no secret is configured", async () => {
      delete process.env.PADDLE_WEBHOOK_SECRET;
      const ts = String(Math.floor(Date.now() / 1000));
      const response = await postPaddleWebhook(request("{}", ts));
      expect(response.status).toBe(404);
    });

    test("a correctly signed subscription event is recorded", async () => {
      process.env.PADDLE_WEBHOOK_SECRET = secret;
      const body = JSON.stringify({
        event_id: "evt_paddle_1",
        event_type: "subscription.activated",
        data: {
          id: "sub_abc",
          customer_id: "ctm_abc",
          status: "active",
          current_billing_period: { ends_at: "2026-09-20T00:00:00.000Z" },
          items: [{ price: { id: "pri_abc" } }],
          custom_data: { organization_id: organizationId },
        },
      });
      const ts = String(Math.floor(Date.now() / 1000));

      const response = await postPaddleWebhook(request(body, ts));
      expect(response.status).toBe(200);

      const [row] = await subscriptionRows();
      expect(row).toMatchObject({ provider: "paddle", providerSubscriptionId: "sub_abc" });
    });

    test("a wrongly signed request is rejected and writes nothing", async () => {
      process.env.PADDLE_WEBHOOK_SECRET = secret;
      const ts = String(Math.floor(Date.now() / 1000));
      const response = await postPaddleWebhook(request("{}", ts, "wrong-secret"));

      expect(response.status).toBe(400);
      expect(await subscriptionRows()).toHaveLength(0);
    });

    describe("with PADDLE_WEBHOOK_IP_ALLOWLIST=true", () => {
      test("accepts a correctly signed event from an allowlisted IP", async () => {
        process.env.PADDLE_WEBHOOK_SECRET = secret;
        process.env.PADDLE_WEBHOOK_IP_ALLOWLIST = "true";
        await primeAllowlist();
        const ts = String(Math.floor(Date.now() / 1000));

        const response = await postPaddleWebhook(request(signedEvent("ip_ok"), ts, secret, ALLOWED_IP));

        expect(response.status).toBe(200);
        const [row] = await subscriptionRows();
        expect(row).toMatchObject({ provider: "paddle", providerSubscriptionId: "sub_ip_ok" });
      });

      test("rejects a caller that is not on the allowlist, before the signature check", async () => {
        process.env.PADDLE_WEBHOOK_SECRET = secret;
        process.env.PADDLE_WEBHOOK_IP_ALLOWLIST = "true";
        await primeAllowlist();
        const ts = String(Math.floor(Date.now() / 1000));

        // Body is validly signed; the 403 is the IP gate, not the signature.
        const response = await postPaddleWebhook(request(signedEvent("ip_no"), ts, secret, "203.0.113.9"));

        expect(response.status).toBe(403);
        expect(await subscriptionRows()).toHaveLength(0);
      });

      test("still processes the event when Paddle's IP endpoint is unreachable", async () => {
        process.env.PADDLE_WEBHOOK_SECRET = secret;
        process.env.PADDLE_WEBHOOK_IP_ALLOWLIST = "true";
        // getPaddleIpAllowlist() resolves to null (endpoint down, nothing
        // cached), so the signature check stays the gate rather than every
        // delivery being dropped.
        resetPaddleIpAllowlistCache();
        vi.stubGlobal("fetch", async () => {
          throw new Error("network down");
        });
        const ts = String(Math.floor(Date.now() / 1000));

        const response = await postPaddleWebhook(request(signedEvent("ip_degraded"), ts, secret, "203.0.113.9"));

        expect(response.status).toBe(200);
      });
    });

    test("ignores the caller IP while the flag is unset", async () => {
      process.env.PADDLE_WEBHOOK_SECRET = secret;
      const ts = String(Math.floor(Date.now() / 1000));

      const response = await postPaddleWebhook(request(signedEvent("flag_off"), ts, secret, "203.0.113.9"));

      expect(response.status).toBe(200);
    });
  });

  describe("POST /api/v1/webhooks/lemon-squeezy", () => {
    const secret = "lemon_squeezy_test_secret_1234567890";

    afterEach(() => {
      delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    });

    function request(body: string, secretForSignature = secret) {
      const signature = createHmac("sha256", secretForSignature).update(body).digest("hex");
      return new Request("https://example.com/api/v1/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "x-signature": signature },
        body,
      });
    }

    test("404s when no secret is configured", async () => {
      delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
      const response = await postLemonSqueezyWebhook(request("{}"));
      expect(response.status).toBe(404);
    });

    test("a correctly signed subscription event is recorded", async () => {
      process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = secret;
      const body = JSON.stringify({
        meta: {
          event_name: "subscription_created",
          custom_data: { organization_id: organizationId },
        },
        data: {
          id: "ls_sub_1",
          attributes: {
            status: "on_trial",
            customer_id: 42,
            variant_id: 7,
            renews_at: "2026-09-20T00:00:00.000000Z",
            cancelled: false,
            urls: { customer_portal: "https://lemonsqueezy.example/portal" },
          },
        },
      });

      const response = await postLemonSqueezyWebhook(request(body));
      expect(response.status).toBe(200);

      const [row] = await subscriptionRows();
      expect(row).toMatchObject({ provider: "lemon_squeezy", providerSubscriptionId: "ls_sub_1", status: "trialing" });
    });

    test("a wrongly signed request is rejected and writes nothing", async () => {
      process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = secret;
      const response = await postLemonSqueezyWebhook(request("{}", "wrong-secret"));

      expect(response.status).toBe(400);
      expect(await subscriptionRows()).toHaveLength(0);
    });
  });
});
