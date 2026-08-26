import { describe, expect, test } from "vitest";

import { parseConsent, serializeConsent, type ConsentState } from "./cookie-consent";

describe("parseConsent", () => {
  test("round-trips a value serializeConsent produced", () => {
    const state: ConsentState = { analytics: true, updatedAt: new Date().toISOString() };
    expect(parseConsent(serializeConsent(state))).toEqual(state);
  });

  test("rejects a missing cookie", () => {
    expect(parseConsent(null)).toBeNull();
  });

  test("rejects malformed JSON", () => {
    expect(parseConsent("not-json")).toBeNull();
  });

  test("rejects a non-boolean analytics field", () => {
    const raw = encodeURIComponent(JSON.stringify({ analytics: "yes", updatedAt: new Date().toISOString() }));
    expect(parseConsent(raw)).toBeNull();
  });

  test("rejects an invalid updatedAt", () => {
    const raw = encodeURIComponent(JSON.stringify({ analytics: true, updatedAt: "not-a-date" }));
    expect(parseConsent(raw)).toBeNull();
  });
});
