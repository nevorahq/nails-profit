import { createHash } from "node:crypto";

import { getNotificationProviderName } from "@/env";
import { notificationProvider } from "@/lib/notification-provider";

/**
 * Delivery for the "confirm your address" link.
 *
 * Same shape and the same reasoning as `lib/password-reset-delivery.ts`: the
 * link is a bearer credential, so it only ever travels out of band — the log in
 * development, Resend in production, and a loud refusal for any other provider
 * rather than a silent no-op that would leave every new account unverifiable.
 *
 * The address is verified because it is the only way back into an account. A
 * studio that mistypes it at registration keeps working — nothing here blocks
 * the product — right up until the day it needs a password reset, and then the
 * reset goes to an address nobody owns. Catching the typo in the first minute
 * is the whole job.
 */
export type VerificationMessage = Readonly<{
  email: string;
  url: string;
}>;

export interface VerificationDelivery {
  send(message: VerificationMessage): Promise<void>;
}

export class MissingVerificationTransportError extends Error {
  readonly code = "VERIFICATION_TRANSPORT_MISSING";

  constructor() {
    super(
      "No verification transport is configured. Wire a mail provider before running in production — " +
        "an unverifiable address cannot recover its own account.",
    );
    this.name = "MissingVerificationTransportError";
  }
}

/** Development only: prints the link so a local account can confirm itself. */
export const consoleVerificationDelivery: VerificationDelivery = {
  async send({ email, url }) {
    console.warn(
      `[verify-email] development delivery — this link is a credential and must never be logged in production\n` +
        `  to:   ${email}\n  link: ${url}`,
    );
  },
};

export const productionRefusalVerificationDelivery: VerificationDelivery = {
  async send() {
    throw new MissingVerificationTransportError();
  },
};

export const resendVerificationDelivery: VerificationDelivery = {
  async send({ email, url }) {
    const result = await notificationProvider("email").send({
      channel: "email",
      destination: email,
      subject: "Confirm your Nail Profit OS address",
      body:
        `Confirm this address so your Nail Profit OS account can be recovered if you ever lose the password.\n\n${url}\n\n` +
        `If you did not create an account, ignore this email. The link expires in 24 hours.`,
      // The URL carries a unique token; hashing keeps it out of Resend's
      // idempotency metadata while retries stay identifiable.
      idempotencyKey: `verify-email/${createHash("sha256").update(url).digest("hex")}`,
    });
    if (!result.ok) throw new Error(`VERIFICATION_DELIVERY_FAILED:${result.code}`);
  },
};

export function resolveVerificationDelivery(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  provider: "log" | "resend" = getNotificationProviderName(),
): VerificationDelivery {
  if (nodeEnv !== "production") return consoleVerificationDelivery;
  return provider === "resend" ? resendVerificationDelivery : productionRefusalVerificationDelivery;
}
