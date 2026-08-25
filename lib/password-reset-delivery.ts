import { createHash } from "node:crypto";

import { getNotificationProviderName } from "@/env";
import { notificationProvider } from "@/lib/notification-provider";

/**
 * Delivery for password reset links, spec section 4.3 ("восстановление доступа").
 *
 * Unlike an invitation token, a reset link cannot be handed back through the
 * API: anyone could request a reset for an address they do not own and read the
 * token out of the response. So the link is only ever delivered out of band.
 *
 * In development it goes to the server log. That is deliberately confined to
 * development — spec section 15.3 forbids secrets in logs, and a reset URL is a
 * bearer credential. In production Resend delivers it; any other configured
 * provider fails loudly rather than pretending to send it.
 *
 * The check happens per request, not at module load, because `next build`
 * evaluates this module with NODE_ENV=production while collecting page data;
 * throwing there would break the build instead of the flow it is guarding.
 */

export type PasswordResetMessage = Readonly<{
  email: string;
  url: string;
}>;

export interface PasswordResetDelivery {
  send(message: PasswordResetMessage): Promise<void>;
}

export class MissingPasswordResetTransportError extends Error {
  readonly code = "PASSWORD_RESET_TRANSPORT_MISSING";

  constructor() {
    super(
      "No password reset transport is configured. Wire a mail provider before running in production — " +
        "spec section 4.3 treats account recovery as a function the MVP cannot ship without.",
    );
    this.name = "MissingPasswordResetTransportError";
  }
}

/** Development only: prints the link so a local account can be recovered. */
export const consolePasswordResetDelivery: PasswordResetDelivery = {
  async send({ email, url }) {
    console.warn(
      `[password-reset] development delivery — this link is a credential and must never be logged in production\n` +
        `  to:   ${email}\n  link: ${url}`,
    );
  },
};

export const productionRefusalDelivery: PasswordResetDelivery = {
  async send() {
    throw new MissingPasswordResetTransportError();
  },
};

/** Production account recovery through the provider chosen for Phase 7. */
export const resendPasswordResetDelivery: PasswordResetDelivery = {
  async send({ email, url }) {
    const result = await notificationProvider("email").send({
      channel: "email",
      destination: email,
      subject: "Reset your Nail Profit OS password",
      body: `A password reset was requested for your Nail Profit OS account.\n\n${url}\n\nIf you did not request it, ignore this email. The link expires in one hour.`,
      // The URL contains a unique bearer token. Hashing keeps that secret out
      // of Resend's idempotency metadata while preserving retry identity.
      idempotencyKey: `password-reset/${createHash("sha256").update(url).digest("hex")}`,
    });
    if (!result.ok) throw new Error(`PASSWORD_RESET_DELIVERY_FAILED:${result.code}`);
  },
};

export function resolvePasswordResetDelivery(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  provider: "log" | "resend" = getNotificationProviderName(),
): PasswordResetDelivery {
  if (nodeEnv !== "production") return consolePasswordResetDelivery;
  return provider === "resend" ? resendPasswordResetDelivery : productionRefusalDelivery;
}
