import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BillingSettings } from "@/components/billing-settings";
import { checkoutLabel } from "@/components/plan-checkout";

describe("checkoutLabel", () => {
  it("names the tier and its monthly price", () => {
    expect(checkoutLabel("studio", 1, "ru")).toMatch(/^Оформить подписку · Студия, 19\s€ в месяц$/);
    expect(checkoutLabel("solo", 1, "en")).toBe("Subscribe · Solo, €9 a month");
  });

  it("names the amount actually charged for a prepay", () => {
    expect(checkoutLabel("studio", 6, "en")).toBe("Subscribe · Studio, €95 for 6 months");
    expect(checkoutLabel("business", 12, "ru")).toMatch(/^Оформить подписку · Бизнес, 351\s€ за 12 мес\.$/);
  });
});

describe("BillingSettings", () => {
  const base = { subscription: null, organizationId: "org", locale: "en" as const };
  const sandbox = { clientToken: "t", environment: "sandbox" as const, discountCode: null };

  it("offers the three paid tiers and three periods, with Studio monthly chosen", () => {
    const html = renderToStaticMarkup(
      createElement(BillingSettings, { ...base, checkout: { paddle: sandbox, lemonSqueezyUrl: null } }),
    );
    expect(html.match(/name="billing-tier"/g)).toHaveLength(3);
    expect(html.match(/name="billing-period"/g)).toHaveLength(3);
    expect(html).toContain("Subscribe · Studio, €19 a month");
    expect(html).toContain("6 months · −17%");
    expect(html).toContain("12 months · −25%");
    expect(html).toContain("then +€4 a month each");
  });

  it("draws one checkout even when both providers are set up, and it is Paddle's", () => {
    const html = renderToStaticMarkup(
      createElement(BillingSettings, {
        ...base,
        checkout: { paddle: sandbox, lemonSqueezyUrl: "https://shop.lemonsqueezy.com/checkout/buy/x" },
      }),
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("lemonsqueezy");
  });

  it("speaks of the founder code only when one is prefilled", () => {
    const withCode = renderToStaticMarkup(
      createElement(BillingSettings, {
        ...base,
        checkout: { paddle: { ...sandbox, discountCode: "FOUNDER30" }, lemonSqueezyUrl: null },
      }),
    );
    expect(withCode).toContain("Code FOUNDER30 is already applied at checkout");

    const without = renderToStaticMarkup(
      createElement(BillingSettings, { ...base, checkout: { paddle: sandbox, lemonSqueezyUrl: null } }),
    );
    expect(without).not.toContain("FOUNDER30");
  });

  it("draws no checkout where Paddle has no catalog of this grid yet", () => {
    const html = renderToStaticMarkup(
      createElement(BillingSettings, {
        ...base,
        checkout: {
          paddle: { ...sandbox, environment: "live" },
          lemonSqueezyUrl: "https://shop.lemonsqueezy.com/checkout/buy/x",
        },
      }),
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("lemonsqueezy");
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
