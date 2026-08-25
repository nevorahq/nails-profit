import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyHmacHex } from "@/lib/webhook-hmac";

function sign(content: string, secret: string) {
  return createHmac("sha256", secret).update(content).digest("hex");
}

describe("verifyHmacHex", () => {
  it("accepts a signature computed with the same secret", () => {
    const secret = "test-secret";
    const body = '{"hello":"world"}';
    expect(verifyHmacHex(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = '{"hello":"world"}';
    expect(verifyHmacHex(body, sign(body, "right-secret"), "wrong-secret")).toBe(false);
  });

  it("rejects a signature for different content", () => {
    const secret = "test-secret";
    expect(verifyHmacHex("body-a", sign("body-b", secret), secret)).toBe(false);
  });

  it("rejects garbage that is not valid hex", () => {
    expect(verifyHmacHex("body", "not-hex-!!", "secret")).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyHmacHex("body", "", "secret")).toBe(false);
  });
});
