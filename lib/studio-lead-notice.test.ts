import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceStudioLead,
  consoleStudioLeadNotice,
  createResendStudioLeadNotice,
  describeStudioLead,
  resolveStudioLeadNotice,
  type StudioLead,
} from "@/lib/studio-lead-notice";
import { setNotificationProvider, type OutgoingMessage } from "@/lib/notification-provider";

const lead: StudioLead = {
  organizationId: "018f51aa-3f92-7c65-98d5-101ce56d552f",
  organizationName: "Frumusete Irina",
  slug: "frumusete-irina",
  type: "solo",
  currency: "MDL",
  locale: "ro",
  ownerName: "Irina",
  ownerEmail: "irina@studio.example",
};

afterEach(() => {
  vi.restoreAllMocks();
  setNotificationProvider(null);
  delete process.env.SUPPORT_EMAIL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("resolveStudioLeadNotice", () => {
  it("says nothing, without PII, when no address is configured", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages: OutgoingMessage[] = [];
    setNotificationProvider({
      name: "fake-resend",
      async send(message) {
        messages.push(message);
        return { ok: true, providerMessageId: "email_lead" };
      },
    });

    await resolveStudioLeadNotice("production", "resend", null).send(lead);

    expect(messages).toEqual([]);
    // The warning exists so an unconfigured channel is visible rather than
    // silent — but it may not carry the lead it failed to announce.
    const line = printed.mock.calls[0]?.[0] as string;
    expect(line).toContain("studio_lead.unannounced");
    expect(line).toContain("no_recipient");
    expect(line).not.toContain("irina@studio.example");
    expect(line).not.toContain("Irina");
  });

  it("keeps a production log provider from printing the owner's address", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});

    await resolveStudioLeadNotice("production", "log", "support@nevorahq.example").send(lead);

    const line = printed.mock.calls[0]?.[0] as string;
    expect(line).toContain("no_transport");
    expect(line).not.toContain("irina@studio.example");
  });

  it("prints the lead in development instead of mailing it", () => {
    for (const env of ["development", "test", undefined]) {
      expect(resolveStudioLeadNotice(env, "resend", "support@nevorahq.example")).toBe(
        consoleStudioLeadNotice,
      );
    }
  });

  it("mails the operator in production", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const messages: OutgoingMessage[] = [];
    setNotificationProvider({
      name: "fake-resend",
      async send(message) {
        messages.push(message);
        return { ok: true, providerMessageId: "email_lead" };
      },
    });

    await resolveStudioLeadNotice("production", "resend", "support@nevorahq.example").send(lead);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: "email",
      destination: "support@nevorahq.example",
      subject: "New studio: Frumusete Irina",
      // The organization is created once, so a retried request is the same
      // announcement rather than a second one.
      idempotencyKey: "studio-lead/018f51aa-3f92-7c65-98d5-101ce56d552f",
    });
    expect(messages[0].body).toContain("irina@studio.example");
    expect(messages[0].body).toContain("https://app.example.com/book/frumusete-irina");
  });
});

describe("describeStudioLead", () => {
  it("leaves out the booking address when the deployment has no public URL", () => {
    expect(describeStudioLead(lead)).not.toContain("Booking:");
  });

  it("names what a first sales conversation needs", () => {
    const summary = describeStudioLead(lead);
    expect(summary).toContain("Frumusete Irina");
    expect(summary).toContain("solo");
    expect(summary).toContain("MDL");
    expect(summary).toContain("Irina <irina@studio.example>");
  });
});

describe("announceStudioLead", () => {
  it("swallows a provider failure so a registration is never lost to a letter", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    setNotificationProvider({
      name: "failing",
      async send() {
        return { ok: false, code: "resend_rate_limited", retryable: true };
      },
    });

    await expect(
      createResendStudioLeadNotice("support@nevorahq.example").send(lead),
    ).rejects.toThrow("STUDIO_LEAD_DELIVERY_FAILED:resend_rate_limited");

    /*
     * The same failure through the wrapper the route calls. The notice is
     * passed in rather than resolved from the environment: what is under test
     * is that a refused send leaves the registration alone, and that holds
     * whichever transport refused it.
     */
    await expect(
      announceStudioLead(lead, "req-1", {
        async send() {
          throw new Error("STUDIO_LEAD_DELIVERY_FAILED:resend_rate_limited");
        },
      }),
    ).resolves.toBeUndefined();

    const line = printed.mock.calls.map((call) => String(call[0])).at(-1) ?? "";
    expect(line).toContain("studio_lead.announce_failed");
    expect(line).toContain("req-1");
    expect(line).toContain(lead.organizationId);
  });
});
