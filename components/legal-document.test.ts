import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegalDocument } from "@/components/legal-document";
import { REFUND_DAYS } from "@/lib/legal";
import { privacyContent, refundContent, termsContent } from "@/lib/legal-content";

const locales = ["ru", "ro", "en"] as const;

function render(operator: { name: string | null; email: string | null }) {
  return renderToStaticMarkup(
    createElement(LegalDocument, {
      locale: "en",
      title: "Refunds and cancellation",
      version: "2026-10-15",
      document: refundContent.en,
      operator,
    }),
  );
}

describe("LegalDocument operator block", () => {
  it("names the operator and links the support address", () => {
    const html = render({ name: "Nevora SRL", email: "help@example.test" });
    expect(html).toContain("Nevora SRL");
    expect(html).toContain('href="mailto:help@example.test"');
  });

  it("shows the address alone when no name is configured", () => {
    const html = render({ name: null, email: "help@example.test" });
    expect(html).toContain('href="mailto:help@example.test"');
    expect(html).not.toContain("Nevora");
  });

  it("shows the name alone when no address is configured", () => {
    const html = render({ name: "Nevora SRL", email: null });
    expect(html).toContain("Nevora SRL");
    expect(html).not.toContain("mailto:");
  });

  it("leaves the block out when neither is configured", () => {
    const html = render({ name: null, email: null });
    expect(html).not.toContain("Service operator</h2>");
    expect(html).not.toContain("mailto:");
  });

  it("links the three public policies from every page", () => {
    const html = render({ name: null, email: null });
    for (const href of ["/terms", "/privacy", "/refund"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("public policy text", () => {
  it.each(locales)("states the refund window in %s", (locale) => {
    expect(JSON.stringify(refundContent[locale])).toContain(String(REFUND_DAYS));
  });

  it.each(locales)("no longer sends a paying customer to a pilot agreement in %s", (locale) => {
    const pilotPointers = /договор[а-я]* пилота|acord(?:ul)? pilot|pilot agreement/i;
    expect(privacyContent[locale].intro + JSON.stringify(privacyContent[locale].sections)).not.toMatch(pilotPointers);
    expect(termsContent[locale].intro).not.toMatch(pilotPointers);
  });

  it.each(locales)("names Paddle as the seller in the terms in %s", (locale) => {
    expect(JSON.stringify(termsContent[locale])).toContain("Paddle");
  });
});
