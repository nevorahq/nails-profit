import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseLemonSqueezyEvent, verifyLemonSqueezyWebhook } from "@/lib/lemon-squeezy-webhook";

function sign(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyLemonSqueezyWebhook", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"meta":{}}';
    expect(verifyLemonSqueezyWebhook(body, sign(body, "secret"), "secret")).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const body = '{"meta":{}}';
    expect(verifyLemonSqueezyWebhook(body, sign(body, "other"), "secret")).toBe(false);
  });
});

describe("parseLemonSqueezyEvent", () => {
  const validPayload = {
    meta: {
      event_name: "subscription_updated",
      custom_data: { organization_id: "8ca81c80-e14a-4f25-91a7-b01ee611503a" },
    },
    data: {
      id: "12345",
      attributes: {
        status: "active",
        customer_id: 6789,
        variant_id: 1111,
        renews_at: "2026-09-20T00:00:00.000000Z",
        cancelled: false,
        urls: { customer_portal: "https://lemonsqueezy.example/portal" },
      },
    },
  };

  it("normalizes a valid subscription event", () => {
    expect(parseLemonSqueezyEvent(validPayload)).toEqual({
      provider: "lemon_squeezy",
      organizationId: "8ca81c80-e14a-4f25-91a7-b01ee611503a",
      providerCustomerId: "6789",
      providerSubscriptionId: "12345",
      providerPriceId: "1111",
      status: "active",
      currentPeriodEnd: new Date("2026-09-20T00:00:00.000000Z"),
      cancelAtPeriodEnd: false,
      manageUrl: "https://lemonsqueezy.example/portal",
      rawEventType: "subscription_updated",
    });
  });

  it("maps on_trial and cancelled onto trialing and canceled", () => {
    expect(
      parseLemonSqueezyEvent({
        ...validPayload,
        data: { ...validPayload.data, attributes: { ...validPayload.data.attributes, status: "on_trial" } },
      })?.status,
    ).toBe("trialing");
    expect(
      parseLemonSqueezyEvent({
        ...validPayload,
        data: { ...validPayload.data, attributes: { ...validPayload.data.attributes, status: "cancelled" } },
      })?.status,
    ).toBe("canceled");
  });

  it("collapses unpaid and expired onto canceled", () => {
    for (const status of ["unpaid", "expired"]) {
      expect(
        parseLemonSqueezyEvent({
          ...validPayload,
          data: { ...validPayload.data, attributes: { ...validPayload.data.attributes, status } },
        })?.status,
      ).toBe("canceled");
    }
  });

  it("ignores a non-subscription event", () => {
    expect(
      parseLemonSqueezyEvent({
        ...validPayload,
        meta: { ...validPayload.meta, event_name: "order_created" },
      }),
    ).toBeNull();
  });

  it("ignores an event with no organization_id in custom_data", () => {
    expect(
      parseLemonSqueezyEvent({
        ...validPayload,
        meta: { event_name: "subscription_updated", custom_data: {} },
      }),
    ).toBeNull();
  });
});
