import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MissingPasswordResetTransportError,
  consolePasswordResetDelivery,
  productionRefusalDelivery,
  resendPasswordResetDelivery,
  resolvePasswordResetDelivery,
} from "@/lib/password-reset-delivery";
import { setNotificationProvider, type OutgoingMessage } from "@/lib/notification-provider";

afterEach(() => {
  vi.restoreAllMocks();
  setNotificationProvider(null);
});

describe("resolvePasswordResetDelivery", () => {
  it("refuses to deliver in production rather than silently dropping the link", async () => {
    const delivery = resolvePasswordResetDelivery("production", "log");
    expect(delivery).toBe(productionRefusalDelivery);
    await expect(
      delivery.send({ email: "owner@example.com", url: "https://example.com/r/abc" }),
    ).rejects.toBeInstanceOf(MissingPasswordResetTransportError);
  });

  it("uses console delivery outside production", () => {
    for (const env of ["development", "test", undefined]) {
      expect(resolvePasswordResetDelivery(env, "resend")).toBe(consolePasswordResetDelivery);
    }
  });

  it("uses Resend in production without logging the reset credential", async () => {
    const messages: OutgoingMessage[] = [];
    setNotificationProvider({
      name: "fake-resend",
      async send(message) {
        messages.push(message);
        return { ok: true, providerMessageId: "email_reset" };
      },
    });

    const delivery = resolvePasswordResetDelivery("production", "resend");
    expect(delivery).toBe(resendPasswordResetDelivery);
    await delivery.send({ email: "owner@example.com", url: "https://example.com/r/secret" });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: "email",
      destination: "owner@example.com",
    });
    expect(messages[0].body).toContain("https://example.com/r/secret");
    expect(messages[0].idempotencyKey).not.toContain("secret");
  });
});

describe("consolePasswordResetDelivery", () => {
  it("prints the link with the address so a local account can be recovered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await consolePasswordResetDelivery.send({
      email: "owner@example.com",
      url: "https://example.com/r/abc",
    });

    const output = warn.mock.calls[0]?.[0] as string;
    expect(output).toContain("owner@example.com");
    expect(output).toContain("https://example.com/r/abc");
    // The warning has to say why this is development-only, or someone will wire
    // it up in production and put a bearer credential into the logs.
    expect(output).toContain("never be logged in production");
  });
});
