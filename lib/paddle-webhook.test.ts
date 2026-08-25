import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parsePaddleEvent, parsePaddleSignatureHeader, verifyPaddleWebhook } from "@/lib/paddle-webhook";

function sign(ts: string, body: string, secret: string) {
  return createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
}

describe("parsePaddleSignatureHeader", () => {
  it("parses ts and h1 regardless of order", () => {
    expect(parsePaddleSignatureHeader("h1=abc;ts=123")).toEqual({ ts: "123", h1: "abc" });
  });

  it("returns null when either part is missing", () => {
    expect(parsePaddleSignatureHeader("ts=123")).toBeNull();
    expect(parsePaddleSignatureHeader("")).toBeNull();
  });
});

describe("verifyPaddleWebhook", () => {
  const secret = "pdl_ntfset_test";
  const body = '{"event_id":"evt_1"}';
  const now = new Date("2026-08-20T12:00:00.000Z");
  const ts = String(Math.floor(now.getTime() / 1000));

  it("accepts a correctly signed, fresh request", () => {
    const header = { ts, h1: sign(ts, body, secret) };
    expect(verifyPaddleWebhook(body, header, secret, now)).toBe(true);
  });

  it("rejects a stale timestamp", () => {
    const staleTs = String(Math.floor(now.getTime() / 1000) - 3600);
    const header = { ts: staleTs, h1: sign(staleTs, body, secret) };
    expect(verifyPaddleWebhook(body, header, secret, now)).toBe(false);
  });

  it("rejects a wrong signature", () => {
    const header = { ts, h1: sign(ts, body, "different-secret") };
    expect(verifyPaddleWebhook(body, header, secret, now)).toBe(false);
  });
});

describe("parsePaddleEvent", () => {
  const validPayload = {
    event_id: "evt_1",
    event_type: "subscription.updated",
    data: {
      id: "sub_123",
      customer_id: "ctm_123",
      status: "active",
      current_billing_period: { ends_at: "2026-09-20T00:00:00.000Z" },
      scheduled_change: null,
      items: [{ price: { id: "pri_123" } }],
      custom_data: { organization_id: "8ca81c80-e14a-4f25-91a7-b01ee611503a" },
      management_urls: { update_payment_method: "https://paddle.example/manage" },
    },
  };

  it("normalizes a valid subscription event", () => {
    expect(parsePaddleEvent(validPayload)).toEqual({
      provider: "paddle",
      organizationId: "8ca81c80-e14a-4f25-91a7-b01ee611503a",
      providerCustomerId: "ctm_123",
      providerSubscriptionId: "sub_123",
      providerPriceId: "pri_123",
      status: "active",
      currentPeriodEnd: new Date("2026-09-20T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      manageUrl: "https://paddle.example/manage",
      rawEventType: "subscription.updated",
    });
  });

  it("marks cancelAtPeriodEnd when Paddle has a scheduled cancellation", () => {
    const event = parsePaddleEvent({
      ...validPayload,
      data: { ...validPayload.data, scheduled_change: { action: "cancel" } },
    });
    expect(event?.cancelAtPeriodEnd).toBe(true);
  });

  it("ignores a non-subscription event", () => {
    expect(parsePaddleEvent({ ...validPayload, event_type: "transaction.completed" })).toBeNull();
  });

  it("ignores an event with no organization_id in custom_data", () => {
    const event = parsePaddleEvent({
      ...validPayload,
      data: { ...validPayload.data, custom_data: {} },
    });
    expect(event).toBeNull();
  });

  it("ignores an unrecognized status", () => {
    const event = parsePaddleEvent({
      ...validPayload,
      data: { ...validPayload.data, status: "some_future_status" },
    });
    expect(event).toBeNull();
  });
});
