import {
  getNotificationProviderName,
  getPublicAppUrl,
  getSupportEmail,
} from "@/env";
import { logEvent } from "@/lib/logger";
import { notificationProvider } from "@/lib/notification-provider";

/**
 * The letter that says a studio has registered.
 *
 * It exists because a sign-up was, until now, an event with no reader: the row
 * appeared in `organization` and nobody learned of it until someone thought to
 * look. Every studio that registers is a conversation worth having in its first
 * days — while the owner still remembers why they came — and a conversation
 * nobody knows to start is the same as one that never happened.
 *
 * Two things it deliberately is not.
 *
 * It is not a gate. The studio is created, its owner is signed in, and this
 * letter is sent afterwards on the way out; a provider that is down, misconfigured
 * or slow delays nothing and refuses nobody. Access is decided — where it is
 * decided at all — by `pilot_enrollment` and `PILOT_ACCESS_ENFORCEMENT`, which
 * this file never reads.
 *
 * And it is not the notification queue. `notification` is tenant-scoped, retried
 * and dead-lettered for messages a studio sends to its own clients; this one is
 * addressed to the operator, belongs to no tenant, and is worth exactly one
 * attempt. `NOTIFICATIONS_ENABLED` — the section 7 rollback switch, which pauses
 * that queue without losing what it holds — is for the same reason not consulted
 * here: pausing client mail during a provider incident should not also stop the
 * operator hearing that somebody signed up.
 */

export type StudioLead = Readonly<{
  organizationId: string;
  organizationName: string;
  /** Null only for a row from before the address was given rather than asked for. */
  slug: string | null;
  /** `solo` or `studio`, as registered — the first thing a sales conversation needs. */
  type: string;
  currency: string;
  locale: string;
  ownerName: string;
  ownerEmail: string;
}>;

export interface StudioLeadNotice {
  send(lead: StudioLead): Promise<void>;
}

/**
 * What the operator reads, built once so the development log and the letter
 * cannot drift into saying different things about the same studio.
 */
export function describeStudioLead(lead: StudioLead): string {
  const appUrl = getPublicAppUrl();
  const lines = [
    `Studio:   ${lead.organizationName} (${lead.type}, ${lead.currency}, ${lead.locale})`,
    `Owner:    ${lead.ownerName} <${lead.ownerEmail}>`,
    `Org id:   ${lead.organizationId}`,
  ];
  if (appUrl && lead.slug) lines.push(`Booking:  ${appUrl}/book/${lead.slug}`);
  return lines.join("\n");
}

/**
 * Nowhere to send it, or no transport to send it with.
 *
 * The lead is not lost — the organization is in the database either way — so
 * this records that the channel is off and returns. The line carries the
 * organization id and nothing else: section 15.6 keeps PII out of logs, and an
 * owner's address and name are exactly what a lead is made of.
 */
function silentNotice(reason: "no_recipient" | "no_transport"): StudioLeadNotice {
  return {
    async send(lead) {
      logEvent(
        "warn",
        "studio_lead.unannounced",
        { organizationId: lead.organizationId },
        { reason },
      );
    },
  };
}

/**
 * Development delivery: the whole lead, printed. Confined to non-production by
 * `resolveStudioLeadNotice`, because in production these same lines would put a
 * name and an address into the log aggregator.
 */
export const consoleStudioLeadNotice: StudioLeadNotice = {
  async send(lead) {
    console.warn(`[studio-lead] development delivery — not sent anywhere\n${describeStudioLead(lead)}`);
  },
};

/** The operator's letter, through the provider the pilot already sends with. */
export function createResendStudioLeadNotice(to: string): StudioLeadNotice {
  return {
    async send(lead) {
      const result = await notificationProvider("email").send({
        channel: "email",
        destination: to,
        subject: `New studio: ${lead.organizationName}`,
        body: `${describeStudioLead(lead)}\n\nRegistered just now. Nothing is blocking this studio — it is already working.`,
        // An organization is created once, so its id is the natural key: a
        // retried request reaches Resend as the same logical send rather than
        // as a second announcement of the same studio.
        idempotencyKey: `studio-lead/${lead.organizationId}`,
        tags: [{ name: "template", value: "studio_lead" }],
      });
      if (!result.ok) throw new Error(`STUDIO_LEAD_DELIVERY_FAILED:${result.code}`);
    },
  };
}

/**
 * Resolved per call rather than at module load, for the reason
 * `resolvePasswordResetDelivery` gives: `next build` evaluates this module with
 * NODE_ENV=production while collecting page data, and a decision frozen there
 * would be the build machine's, not the deployment's.
 */
export function resolveStudioLeadNotice(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  provider: "log" | "resend" = getNotificationProviderName(),
  to: string | null = getSupportEmail(),
): StudioLeadNotice {
  if (to === null) return silentNotice("no_recipient");
  if (nodeEnv !== "production") return consoleStudioLeadNotice;
  return provider === "resend" ? createResendStudioLeadNotice(to) : silentNotice("no_transport");
}

/**
 * Announce a studio, and never let that announcement be the reason a studio
 * failed to register.
 *
 * The caller has already committed the organization and its owner's membership;
 * anything thrown from here would turn a successful registration into a 500 and
 * a person who cannot tell whether they have an account. So the failure is
 * logged and swallowed — `logEvent` masks the address the provider's own error
 * message may be carrying.
 */
export async function announceStudioLead(
  lead: StudioLead,
  requestId?: string,
  notice: StudioLeadNotice = resolveStudioLeadNotice(),
): Promise<void> {
  try {
    await notice.send(lead);
    logEvent("info", "studio_lead.announced", { requestId, organizationId: lead.organizationId }, {});
  } catch (error) {
    logEvent(
      "error",
      "studio_lead.announce_failed",
      { requestId, organizationId: lead.organizationId },
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}
