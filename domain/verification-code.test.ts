import { describe, expect, it } from "vitest";

import {
  generateVerificationCode,
  hashVerificationCode,
  normalizeVerificationCode,
  verificationCodeMatches,
  VERIFICATION_CODE_LENGTH,
} from "@/domain/verification-code";

const hold = "8f1d0a2e-6d0f-4a3b-9d5c-2b7d3a4e1c00";
const otherHold = "0b0c9a11-2d3e-4f50-8a6b-7c8d9e0f1a2b";

describe("verification codes", () => {
  it("are six digits, leading zeros included", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(VERIFICATION_CODE_LENGTH);
    }
  });

  it("are not stored in the clear", () => {
    const code = generateVerificationCode();
    const hash = hashVerificationCode(hold, code);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(code);
  });

  it("only open the hold they were issued for", () => {
    // Section 7.9 binds a verification token to its purpose; here the purpose
    // is one slot, so the same digits are worthless against another hold.
    const code = "123456";
    expect(verificationCodeMatches(hold, code, hashVerificationCode(hold, code))).toBe(true);
    expect(verificationCodeMatches(otherHold, code, hashVerificationCode(hold, code))).toBe(false);
  });

  it("refuse a wrong code and a malformed stored hash alike", () => {
    expect(verificationCodeMatches(hold, "000000", hashVerificationCode(hold, "111111"))).toBe(false);
    expect(verificationCodeMatches(hold, "000000", "not-a-hash")).toBe(false);
  });
});

describe("what a client types", () => {
  it("accepts the spacing an SMS invites", () => {
    expect(normalizeVerificationCode("123 456")).toBe("123456");
    expect(normalizeVerificationCode("123-456")).toBe("123456");
    expect(normalizeVerificationCode(" 123456 ")).toBe("123456");
  });

  it("rejects anything that is not six digits", () => {
    expect(normalizeVerificationCode("12345")).toBeNull();
    expect(normalizeVerificationCode("1234567")).toBeNull();
    expect(normalizeVerificationCode("abcdef")).toBeNull();
  });
});
