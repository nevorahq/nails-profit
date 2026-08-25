import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMessaggioNotificationProvider,
  createResendNotificationProvider,
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

describe("Messaggio SMS provider", () => {
  afterEach(() => {
    delete process.env.SMS_PROVIDER;
    delete process.env.MESSAGGIO_LOGIN;
    delete process.env.MESSAGGIO_API_KEY;
    delete process.env.MESSAGGIO_SENDER_ID;
    delete process.env.MESSAGGIO_FROM;
  });

  it("authenticates with the Messaggio-Login header and strips the leading + from the phone number", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return jsonResponse(200, {
        accepted_at: "2026-08-20T12:00:00Z",
        messages: [
          { recipient: { phone: "37360123456" }, message_id: "550e8400-e29b-41d4-a716-446655440000" },
        ],
      });
    });

    const provider = createMessaggioNotificationProvider(
      { login: "onvUser", from: "NailProfit" },
      fetchMock as unknown as typeof fetch,
    );

    await expect(provider.send(SMS)).resolves.toEqual({
      ok: true,
      providerMessageId: "550e8400-e29b-41d4-a716-446655440000",
    });

    const [url, init] = calls[0];
    expect(String(url)).toBe("https://msg.messaggio.com/api/v1/send");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("messaggio-login")).toBe("onvUser");
    expect(JSON.parse(String(init?.body))).toEqual({
      recipients: [{ phone: "37360123456" }],
      channels: ["sms"],
      options: { external_id: SMS.idempotencyKey },
      sms: { from: "NailProfit", content: [{ type: "text", text: SMS.body }] },
    });
  });

  it("packs the outbox row's own id into external_id when tags are present", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return jsonResponse(200, { messages: [{ recipient: { phone: "37360123456" }, message_id: "msg-1" }] });
    });
    const provider = createMessaggioNotificationProvider(
      { login: "onvUser", from: "NailProfit" },
      fetchMock as unknown as typeof fetch,
    );

    const tagged: OutgoingMessage = {
      ...SMS,
      tags: [
        { name: "organization_id", value: "8ca81c80-e14a-4f25-91a7-b01ee611503a" },
        { name: "notification_id", value: "5d0f80ca-46b7-4ff7-ae8f-f4854eaacb4a" },
      ],
    };
    await provider.send(tagged);

    const [, init] = calls[0];
    // This is what lib/messaggio-webhook.ts unpacks a delivery report against
    // — there is no tags/metadata field on Messaggio's own API to carry it.
    expect(JSON.parse(String(init?.body)).options.external_id).toBe(
      "8ca81c80-e14a-4f25-91a7-b01ee611503a:5d0f80ca-46b7-4ff7-ae8f-f4854eaacb4a",
    );
  });

  it("refuses email without making an HTTP request", async () => {
    const fetchMock = vi.fn();
    const provider = createMessaggioNotificationProvider(
      { login: "onvUser", from: "NailProfit" },
      fetchMock as unknown as typeof fetch,
    );

    await expect(provider.send({ ...SMS, channel: "email" })).resolves.toEqual({
      ok: false,
      code: "messaggio_unsupported_channel",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a 500 but not a 400/403/422 request-shape refusal", async () => {
    for (const [status, retryable] of [
      [400, false],
      [403, false],
      [422, false],
      [500, true],
    ] as const) {
      const provider = createMessaggioNotificationProvider(
        { login: "onvUser", from: "NailProfit" },
        vi.fn(async () => jsonResponse(status, { title: "Invalid contents", detail: "x" })) as unknown as typeof fetch,
      );
      await expect(provider.send(SMS)).resolves.toMatchObject({ ok: false, retryable });
    }
  });

  it("treats a per-recipient error inside a 200 as a non-retryable failure", async () => {
    const provider = createMessaggioNotificationProvider(
      { login: "onvUser", from: "NailProfit" },
      vi.fn(async () =>
        jsonResponse(200, {
          messages: [
            {
              recipient: { phone: "37360123456" },
              error: { title: "Invalid phone number", detail: "invalid phone number" },
            },
          ],
        }),
      ) as unknown as typeof fetch,
    );
    await expect(provider.send(SMS)).resolves.toEqual({
      ok: false,
      code: "messaggio_invalid_phone_number",
      retryable: false,
    });
  });

  it("selects Messaggio only when SMS_PROVIDER asks for it", () => {
    expect(notificationProvider("sms").name).toBe("log");

    process.env.SMS_PROVIDER = "messaggio";
    process.env.MESSAGGIO_LOGIN = "onvUser";
    process.env.MESSAGGIO_SENDER_ID = "NailProfit";
    expect(notificationProvider("sms").name).toBe("messaggio");

    // Untouched by the SMS switch — the two channels are independent.
    expect(notificationProvider("email").name).toBe("log");

    delete process.env.MESSAGGIO_LOGIN;
    expect(() => notificationProvider("sms")).toThrow();
  });
});
