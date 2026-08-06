import { afterEach, describe, expect, it } from "vitest";
import { Webhook } from "svix";

import { POST } from "@/app/api/v1/webhooks/resend/route";

const SECRET = "whsec_dGVzdF9yZXNlbmRfd2ViaG9va19zZWNyZXQ=";

function request(body: string, options: { valid: boolean }) {
  const id = "msg_e2e_resend";
  const at = new Date();
  const signature = options.valid ? new Webhook(SECRET).sign(id, at, body) : "v1,invalid";
  return new Request("http://localhost/api/v1/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1_000)),
      "svix-signature": signature,
    },
    body,
  });
}

describe("POST /api/v1/webhooks/resend", () => {
  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  it("is not exposed until a signing secret is configured", async () => {
    const response = await POST(request("{}", { valid: false }));
    expect(response.status).toBe(404);
  });

  it("rejects an invalid signature", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const response = await POST(request("{}", { valid: false }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ received: false });
  });

  it("acknowledges valid non-booking Resend traffic without storing PII", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const body = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "password-reset-email", tags: {} },
    });
    const response = await POST(request(body, { valid: true }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
  });
});
