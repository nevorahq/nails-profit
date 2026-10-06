import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BillingSettings, startLabel } from "@/components/billing-settings";

const monthly = { name: "Студия", amountMinor: 2900, currency: "EUR", interval: "month" } as const;

describe("startLabel", () => {
  it("is the bare action when the provider named no plan", () => {
    expect(startLabel(null, "ru")).toBe("Оформить подписку");
  });

  it("names the tariff and the price with its period", () => {
    expect(startLabel(monthly, "ru")).toMatch(/^Оформить подписку · Студия, 29\s€ в месяц$/);
    expect(startLabel(monthly, "en")).toBe("Subscribe · Студия, €29 a month");
  });

  it("shows cents only when the price has them", () => {
    expect(startLabel({ ...monthly, amountMinor: 2950 }, "en")).toContain("€29.50");
  });

  it("drops the tariff name when there is none, and the period for a one-off price", () => {
    expect(startLabel({ name: null, amountMinor: 9900, currency: "EUR", interval: null }, "en")).toBe("Subscribe · €99");
  });
});

describe("BillingSettings", () => {
  const base = { subscription: null, organizationId: "org", locale: "en" as const };
  const paddle = { clientToken: "t", priceId: "pri_1", environment: "sandbox" as const };

  it("draws one button even when both providers are set up, and it is Paddle's", () => {
    const html = renderToStaticMarkup(
      createElement(BillingSettings, {
        ...base,
        checkout: { paddle, lemonSqueezyUrl: "https://shop.lemonsqueezy.com/checkout/buy/x" },
        plan: monthly,
      }),
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("lemonsqueezy");
    expect(html).toContain("Subscribe · Студия");
  });

  it("falls back to Lemon Squeezy's link when Paddle is not set up", () => {
    const html = renderToStaticMarkup(
      createElement(BillingSettings, {
        ...base,
        checkout: { paddle: null, lemonSqueezyUrl: "https://shop.lemonsqueezy.com/checkout/buy/x" },
      }),
    );
    expect(html).toContain("lemonsqueezy.com/checkout/buy/x");
    expect(html).toContain(">Subscribe<");
  });

  it("draws no button when neither is set up", () => {
    const html = renderToStaticMarkup(
      createElement(BillingSettings, { ...base, checkout: { paddle: null, lemonSqueezyUrl: null } }),
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });
});
