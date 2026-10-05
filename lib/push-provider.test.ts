import { describe, expect, it, vi } from "vitest";

import type { OutgoingMessage } from "@/lib/notification-provider";
import { createWebPushProvider, type PushDependencies } from "@/lib/push-provider";

const message: OutgoingMessage = {
  channel: "push",
  destination: "https://fcm.googleapis.com/fcm/send/device-token",
  subject: "Новая заявка",
  body: JSON.stringify({ title: "Новая заявка", body: "6 окт., 14:00 · Маникюр · Анна", url: "/app", tag: "t" }),
  idempotencyKey: "booking:booking.staff_requested:push:1:push:device",
  push: { organizationId: "org", subscriptionId: "device", p256dh: "key", auth: "secret" },
};

function provider(answer: () => Promise<{ statusCode: number }>) {
  const deps = {
    vapid: { publicKey: "public", privateKey: "private", subject: "mailto:help@studio.example" },
    send: vi.fn(answer),
    forget: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
  } satisfies PushDependencies;
  return { deps, provider: createWebPushProvider(deps) };
}

function rejection(statusCode: number) {
  return () => Promise.reject(Object.assign(new Error("push service said no"), { statusCode }));
}

describe("the web push provider", () => {
  it("delivers, and marks the device as working", async () => {
    const { deps, provider: push } = provider(async () => ({ statusCode: 201 }));
    const result = await push.send(message);

    expect(result).toEqual({ ok: true, providerMessageId: `push:${message.idempotencyKey}` });
    expect(deps.send).toHaveBeenCalledWith(
      { endpoint: message.destination, keys: { p256dh: "key", auth: "secret" } },
      message.body,
      expect.objectContaining({ vapidDetails: deps.vapid, urgency: "high" }),
    );
    expect(deps.touch).toHaveBeenCalledWith("org", "device");
    expect(deps.forget).not.toHaveBeenCalled();
  });

  it.each([410, 404])("forgets the device when the push service answers %i, and does not retry", async (status) => {
    const { deps, provider: push } = provider(rejection(status));
    const result = await push.send(message);

    expect(result).toEqual({ ok: false, code: "webpush_gone", retryable: false });
    expect(deps.forget).toHaveBeenCalledWith("org", "device");
  });

  it.each([429, 500, 503])("retries a busy or failing push service (%i) and keeps the device", async (status) => {
    const { deps, provider: push } = provider(rejection(status));
    expect(await push.send(message)).toEqual({ ok: false, code: `webpush_http_${status}`, retryable: true });
    expect(deps.forget).not.toHaveBeenCalled();
  });

  it("does not retry a key the device did not subscribe with, and keeps the device", async () => {
    // A 403 is this server's keys being wrong, not the phone being gone:
    // forgetting every device on a misconfiguration would lose them all.
    const { deps, provider: push } = provider(rejection(403));
    expect(await push.send(message)).toEqual({ ok: false, code: "webpush_http_403", retryable: false });
    expect(deps.forget).not.toHaveBeenCalled();
  });

  it("retries when nothing answered at all", async () => {
    const { provider: push } = provider(() => Promise.reject(new Error("ECONNRESET")));
    expect(await push.send(message)).toEqual({ ok: false, code: "webpush_unreachable", retryable: true });
  });

  it("refuses a message that is not a push", async () => {
    const { deps, provider: push } = provider(async () => ({ statusCode: 201 }));
    const result = await push.send({ ...message, channel: "email", push: undefined });
    expect(result).toEqual({ ok: false, code: "webpush_unsupported_channel", retryable: false });
    expect(deps.send).not.toHaveBeenCalled();
  });
});
