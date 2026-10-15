import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/script", () => ({
  default: (props: { src: string }) => createElement("script", { "data-paddle-js": props.src }),
}));

import { BillingSettings, type SubscriptionStatusRow } from "@/components/billing-settings";
import { paddleInitializeOptions } from "@/components/paddle-checkout-button";

describe("paddleInitializeOptions", () => {
  it("gives Retain the Paddle customer id when the studio has one", () => {
    expect(paddleInitializeOptions("live_x", "ctm_01abc")).toEqual({
      token: "live_x",
      pwCustomer: { id: "ctm_01abc" },
    });
  });

  it("leaves pwCustomer out before the studio has a Paddle customer", () => {
    expect(paddleInitializeOptions("live_x")).toEqual({ token: "live_x" });
    expect(paddleInitializeOptions("live_x", null)).not.toHaveProperty("pwCustomer");
  });
});

describe("Retain on the subscription block", () => {
  const paddle = { clientToken: "live_x", environment: "live" as const, discountCode: null };
  const subscribed = (overrides: Partial<SubscriptionStatusRow> = {}): SubscriptionStatusRow => ({
    provider: "paddle",
    status: "active",
    current_period_end: null,
    manage_url: null,
    provider_customer_id: "ctm_01abc",
    ...overrides,
  });
  const render = (subscription: SubscriptionStatusRow, withPaddle = true) =>
    renderToStaticMarkup(
      createElement(BillingSettings, {
        subscription,
        organizationId: "org",
        locale: "en",
        checkout: { paddle: withPaddle ? paddle : null, lemonSqueezyUrl: null },
      }),
    );

  it("loads Paddle.js for a studio with a Paddle subscription", () => {
    expect(render(subscribed())).toContain("data-paddle-js");
  });

  it("does not for a Lemon Squeezy subscription", () => {
    expect(render(subscribed({ provider: "lemon_squeezy" }))).not.toContain("data-paddle-js");
  });

  it("does not without a customer id", () => {
    expect(render(subscribed({ provider_customer_id: null }))).not.toContain("data-paddle-js");
  });

  it("does not when Paddle is not configured on this deployment", () => {
    expect(render(subscribed(), false)).not.toContain("data-paddle-js");
  });
});
