import { describe, expect, it } from "vitest";
import { Webhook } from "svix";

import { verifyResendWebhook } from "@/lib/resend-webhook-signature";

const SECRET = "whsec_dGVzdF9yZXNlbmRfd2ViaG9va19zZWNyZXQ=";
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "email_123" } });

describe("Resend webhook signature", () => {
  it("verifies the untouched body and the three Svix headers", () => {
    const id = "msg_test_123";
    const at = new Date();
    const signature = new Webhook(SECRET).sign(id, at, BODY);

    expect(
      verifyResendWebhook(
        BODY,
        {
          "svix-id": id,
          "svix-timestamp": String(Math.floor(at.getTime() / 1_000)),
          "svix-signature": signature,
        },
        SECRET,
      ),
    ).toEqual(JSON.parse(BODY));
  });

  it("rejects an invalid signature and a modified body", () => {
    const id = "msg_test_456";
    const at = new Date();
    const signature = new Webhook(SECRET).sign(id, at, BODY);
    const headers = {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1_000)),
      "svix-signature": signature,
    };

    expect(() => verifyResendWebhook(BODY, { ...headers, "svix-signature": "v1,invalid" }, SECRET)).toThrow();
    expect(() => verifyResendWebhook(`${BODY} `, headers, SECRET)).toThrow();
  });
});
