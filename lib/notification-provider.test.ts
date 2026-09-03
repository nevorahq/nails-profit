import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createResendNotificationProvider,
  createSmsMdNotificationProvider,
  notificationProvider,
  type OutgoingMessage,
} from "@/lib/notification-provider";

const EMAIL: OutgoingMessage = {
  channel: "email",
  destination: "client@example.com",
  subject: "Booking confirmed",
  body: "Your appointment is confirmed.",
  idempotencyKey: "booking.confirmed/018f51aa-3f92-7c65-98d5-101ce56d552f",
};

function response(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Resend notification provider", () => {
  afterEach(() => {
    delete process.env.NOTIFICATION_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
  });

  it("sends text email with provider-side idempotency", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return response(200, { id: "email_123" });
    });
    const provider = createResendNotificationProvider(
      { apiKey: "re_test_secret", from: "Nail Profit <booking@updates.example.com>" },
      fetchMock as unknown as typeof fetch,
    );

    const tagged = {
      ...EMAIL,
      tags: [
        { name: "organization_id", value: "8ca81c80-e14a-4f25-91a7-b01ee611503a" },
        { name: "notification_id", value: "5d0f80ca-46b7-4ff7-ae8f-f4854eaacb4a" },
      ],
    } satisfies OutgoingMessage;
    await expect(provider.send(tagged)).resolves.toEqual({
      ok: true,
      providerMessageId: "email_123",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = calls[0];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(EMAIL.idempotencyKey);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test_secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "Nail Profit <booking@updates.example.com>",
      to: [EMAIL.destination],
      subject: EMAIL.subject,
      text: EMAIL.body,
      tags: tagged.tags,
    });
  });

  it("retries throttling, server errors and a concurrent idempotent request", async () => {
    for (const [status, name] of [
      [429, "rate_limit_exceeded"],
      [500, "internal_server_error"],
      [409, "concurrent_idempotent_requests"],
    ] as const) {
      const provider = createResendNotificationProvider(
        { apiKey: "re_test_secret", from: "booking@example.com" },
        vi.fn(async () => response(status, { name })) as unknown as typeof fetch,
      );
      await expect(provider.send(EMAIL)).resolves.toMatchObject({ ok: false, retryable: true });
    }
  });

  it("does not retry invalid addresses, credentials or idempotent payload conflicts", async () => {
    for (const [status, name] of [
      [422, "invalid_from_address"],
      [403, "invalid_api_key"],
      [409, "invalid_idempotent_request"],
    ] as const) {
      const provider = createResendNotificationProvider(
        { apiKey: "re_test_secret", from: "booking@example.com" },
        vi.fn(async () => response(status, { name })) as unknown as typeof fetch,
      );
      await expect(provider.send(EMAIL)).resolves.toMatchObject({ ok: false, retryable: false });
    }
  });

  it("refuses SMS without making an HTTP request", async () => {
    const fetchMock = vi.fn();
    const provider = createResendNotificationProvider(
      { apiKey: "re_test_secret", from: "booking@example.com" },
      fetchMock as unknown as typeof fetch,
    );

    await expect(provider.send({ ...EMAIL, channel: "sms" })).resolves.toEqual({
      ok: false,
      code: "resend_unsupported_channel",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the studio's name in front of the verified address", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return response(200, { id: "email_123" });
    });
    const provider = createResendNotificationProvider(
      { apiKey: "re_test_secret", from: "Nail Profit <booking@updates.example.com>" },
      fetchMock as unknown as typeof fetch,
    );

    await provider.send({ ...EMAIL, fromName: "studio-2026", html: "<p>hi</p>" });

    const sent = JSON.parse(String(calls[0][1]?.body));
    // The mailbox is the one Resend verified and DKIM signs; only the name in
    // front of it belongs to the tenant.
    expect(sent.from).toBe('"studio-2026" <booking@updates.example.com>');
    expect(sent.html).toBe("<p>hi</p>");
    // Both parts travel together: a client that will not render HTML still has
    // the message.
    expect(sent.text).toBe(EMAIL.body);
  });

  it("refuses to let a studio's name break out of the From header", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return response(200, { id: "email_123" });
    });
    const provider = createResendNotificationProvider(
      { apiKey: "re_test_secret", from: "Nail Profit <booking@updates.example.com>" },
      fetchMock as unknown as typeof fetch,
    );

    // A name carrying a line break would otherwise end the header and start
    // one of the sender's choosing.
    await provider.send({
      ...EMAIL,
      fromName: 'Green\r\nBcc: victim@example.com\r\nX: "Nails"',
    });

    const sent = JSON.parse(String(calls[0][1]?.body));
    expect(sent.from).toBe('"Green Bcc: victim@example.com X: Nails" <booking@updates.example.com>');
    expect(sent.from).not.toContain("\n");
  });

  it("keeps the configured sender when there is no studio name to use", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return response(200, { id: "email_123" });
    });
    const provider = createResendNotificationProvider(
      { apiKey: "re_test_secret", from: "Nail Profit <booking@updates.example.com>" },
      fetchMock as unknown as typeof fetch,
    );

    await provider.send({ ...EMAIL, fromName: "   " });

    const sent = JSON.parse(String(calls[0][1]?.body));
    expect(sent.from).toBe("Nail Profit <booking@updates.example.com>");
    expect(sent.html).toBeUndefined();
  });

  it("selects Resend only when its server credentials are complete", () => {
    process.env.NOTIFICATION_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_secret";
    process.env.RESEND_FROM = "booking@example.com";
    expect(notificationProvider("email").name).toBe("resend");

    delete process.env.RESEND_API_KEY;
    expect(() => notificationProvider("email")).toThrow();
  });
});

const SMS: OutgoingMessage = {
  channel: "sms",
  destination: "+37360123456",
  subject: "",
  body: "Ваша запись подтверждена.",
  idempotencyKey: "booking.confirmed/018f51aa-3f92-7c65-98d5-101ce56d552f",
};

function jsonResponse(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sms.md SMS provider", () => {
  afterEach(() => {
    delete process.env.SMS_PROVIDER;
    delete process.env.SMSMD_API_TOKEN;
    delete process.env.SMSMD_SENDER_ID;
    delete process.env.SMSMD_FROM;
  });

  it("authenticates with the X-Api-Token header and sends the number as stored", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return jsonResponse(200, {
        status: "success",
        httpCode: 200,
        data: {
          id: "787ab0aa-09cd-44f2-aa98-6ebc3cdb2ec6",
          to: "60123456",
          cost: "0.60",
          currency: "MDL",
          segments: 2,
          encoding: "ucs-2",
        },
      });
    });

    const provider = createSmsMdNotificationProvider(
      { token: "smsmd_test_token", from: "NailProfit" },
      fetchMock as unknown as typeof fetch,
    );

    await expect(provider.send(SMS)).resolves.toEqual({
      ok: true,
      providerMessageId: "787ab0aa-09cd-44f2-aa98-6ebc3cdb2ec6",
    });

    const [url, init] = calls[0];
    expect(String(url)).toBe("https://api.sms.md/v3/messages");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-api-token")).toBe("smsmd_test_token");
    // E.164 is one of the forms this API documents as accepted, so the client
    // record's own value is what goes on the wire — no reformatting to get wrong.
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "NailProfit",
      to: "+37360123456",
      text: SMS.body,
    });
  });

  it("refuses email without making an HTTP request", async () => {
    const fetchMock = vi.fn();
    const provider = createSmsMdNotificationProvider(
      { token: "smsmd_test_token", from: "NailProfit" },
      fetchMock as unknown as typeof fetch,
    );

    await expect(provider.send({ ...SMS, channel: "email" })).resolves.toEqual({
      ok: false,
      code: "smsmd_unsupported_channel",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries an empty balance, a rate limit and a platform error, but not a rejected request", async () => {
    for (const [status, code, retryable] of [
      [401, "AUTHENTICATION_REQUIRED", false],
      [403, "SCOPE_FORBIDDEN", false],
      [422, "VALIDATION_ERROR", false],
      // Not the request being wrong — the account being empty. A top-up an hour
      // from now makes the same message send, so it must not dead-letter here.
      [402, "INSUFFICIENT_BALANCE", true],
      [429, "RATE_LIMIT_EXCEEDED", true],
      [500, "INTERNAL_ERROR", true],
    ] as const) {
      const provider = createSmsMdNotificationProvider(
        { token: "smsmd_test_token", from: "NailProfit" },
        vi.fn(async () =>
          jsonResponse(status, { status: "error", httpCode: status, code, message: "An error occurred." }),
        ) as unknown as typeof fetch,
      );
      await expect(provider.send(SMS)).resolves.toMatchObject({
        ok: false,
        code: `smsmd_${code.toLowerCase()}`,
        retryable,
      });
    }
  });

  it("retries a 5xx that carries no readable body", async () => {
    const provider = createSmsMdNotificationProvider(
      { token: "smsmd_test_token", from: "NailProfit" },
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    );
    await expect(provider.send(SMS)).resolves.toEqual({
      ok: false,
      code: "smsmd_http_502",
      retryable: true,
    });
  });

  it("retries a success envelope with no message id, which nothing can be tracked by", async () => {
    const provider = createSmsMdNotificationProvider(
      { token: "smsmd_test_token", from: "NailProfit" },
      vi.fn(async () =>
        jsonResponse(200, { status: "success", httpCode: 200, data: { cost: "0.30" } }),
      ) as unknown as typeof fetch,
    );
    await expect(provider.send(SMS)).resolves.toEqual({
      ok: false,
      code: "smsmd_invalid_response",
      retryable: true,
    });
  });

  it("selects sms.md only when SMS_PROVIDER asks for it", () => {
    expect(notificationProvider("sms").name).toBe("log");

    process.env.SMS_PROVIDER = "smsmd";
    process.env.SMSMD_API_TOKEN = "smsmd_test_token";
    process.env.SMSMD_SENDER_ID = "NailProfit";
    expect(notificationProvider("sms").name).toBe("smsmd");

    // Untouched by the SMS switch — the two channels are independent.
    expect(notificationProvider("email").name).toBe("log");

    delete process.env.SMSMD_API_TOKEN;
    expect(() => notificationProvider("sms")).toThrow();
  });
});
