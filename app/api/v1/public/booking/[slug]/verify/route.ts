import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { parseBookingToken } from "@/domain/booking-token";
import { normalizeVerificationCode } from "@/domain/verification-code";
import { supportedLocales } from "@/i18n/messages";
import { getPublicNotificationChannel } from "@/env";
import { loadSlotContext } from "@/lib/availability-service";
import { confirmVerification, liveHoldFor, requestVerification } from "@/lib/booking-verification";
import { apiError, apiSuccess, toFieldErrors } from "@/lib/http";
import { findPublicOrganization } from "@/lib/public-booking";
import { recordSuspiciousActivity } from "@/lib/bot-challenge";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_VERIFY_RULE } from "@/lib/rate-limit";

/**
 * The contact check of roadmap section 7.2 step 7, on the path section 7.6
 * gives it.
 *
 * Two actions rather than two endpoints, because they are two halves of one
 * exchange over one hold: `request` sends a code to the contact being claimed,
 * `confirm` proves it arrived. The booking endpoint refuses to use a hold whose
 * contact has not been proven when the location asks for verification.
 *
 * Answers say as little as the flow allows. A request is accepted the same way
 * whether or not the number belongs to an existing client — section 7.9 refuses
 * to let this endpoint answer "does this person book here" — and an
 * unrecognised, paused or unpublished page is the same 404 everywhere else in
 * the public API.
 */
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("request"),
    hold_token: z.string().min(40).max(300),
    phone: z.string().trim().min(6).max(40),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable().optional(),
    locale: z.enum(supportedLocales),
  }),
  z.object({
    action: z.literal("confirm"),
    hold_token: z.string().min(40).max(300),
    code: z.string().trim().min(4).max(16),
  }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, caller, refused } = await publicRequest(request, PUBLIC_BOOKING_VERIFY_RULE, "public_booking.verify", {
    challenge: true,
  });
  if (refused) return refused;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { slug } = await params;
  const holdToken = parseBookingToken(parsed.data.hold_token, "hold");
  if (!holdToken) return publicNotFound(id);

  const organization = await findPublicOrganization(slug);
  if (!organization || organization.id !== holdToken.organizationId) return publicNotFound(id);

  const now = new Date();

  type Outcome =
    | Readonly<{ failure: "HOLD_EXPIRED" | "NOT_FOUND" | "NOT_REQUIRED" | "INVALID_CONTACT" }>
    | Readonly<{ challenge: { channel: "sms" | "email"; expiresAt: Date } }>
    | Readonly<{ verification: { ok: boolean; reason?: "unknown" | "expired" | "locked" | "mismatch" } }>;

  const outcome: Outcome = await withTenant(organization.id, async (tx): Promise<Outcome> => {
    const hold = await liveHoldFor(tx, holdToken.tokenHash, now);
    if (!hold) return { failure: "HOLD_EXPIRED" as const };

    const context = await loadSlotContext(tx, hold.locationId);
    if (!context || context.publicStatus !== "published") return { failure: "NOT_FOUND" as const };
    if (context.verificationMode !== "code") return { failure: "NOT_REQUIRED" as const };

    if (parsed.data.action === "request") {
      const challenge = await requestVerification(tx, {
        organizationId: organization.id,
        holdId: hold.id,
        phone: parsed.data.phone,
        email: parsed.data.email ?? null,
        locale: parsed.data.locale,
        // Never past the hold: a code that outlives the slot it was issued for
        // walks a client into a booking that cannot be created.
        ttlMinutes: Math.max(
          1,
          Math.min(
            context.verificationTtlMinutes,
            Math.ceil((hold.expiresAt.getTime() - now.getTime()) / 60_000),
          ),
        ),
        now,
      });
      return challenge ? { challenge } : { failure: "INVALID_CONTACT" as const };
    }

    const code = normalizeVerificationCode(parsed.data.code);
    if (!code) return { verification: { ok: false as const, reason: "mismatch" as const } };
    return { verification: await confirmVerification(tx, { holdId: hold.id, code, now }) };
  });

  if ("failure" in outcome) {
    switch (outcome.failure) {
      case "HOLD_EXPIRED":
        return apiError(409, "HOLD_EXPIRED", "The slot hold has expired", id);
      case "NOT_REQUIRED":
        return apiError(409, "VERIFICATION_NOT_REQUIRED", "This page does not verify contacts", id);
      case "INVALID_CONTACT":
        return getPublicNotificationChannel() === "email"
          ? apiError(422, "INVALID_EMAIL", "A valid email is required", id, {
              fieldErrors: [{ field: "email", code: "invalid_format", message: "Invalid email" }],
            })
          : apiError(422, "INVALID_PHONE", "The phone number is invalid", id, {
              fieldErrors: [{ field: "phone", code: "invalid_format", message: "Invalid phone number" }],
            });
      case "NOT_FOUND":
        return publicNotFound(id);
    }
  }

  if ("challenge" in outcome) {
    return apiSuccess(
      { channel: outcome.challenge.channel, expires_at: outcome.challenge.expiresAt.toISOString() },
      id,
      202,
    );
  }

  if (outcome.verification.ok) return apiSuccess({ verified: true }, id);

  // A wrong code is the cheapest thing for a script to produce and the rarest
  // thing for a client to produce ten times, which is what section 7.9's
  // threshold is about.
  await recordSuspiciousActivity(caller);

  switch (outcome.verification.reason) {
    case "expired":
      return apiError(409, "VERIFICATION_EXPIRED", "The code has expired", id);
    case "locked":
      return apiError(429, "VERIFICATION_LOCKED", "Too many attempts for this code", id);
    default:
      return apiError(422, "VERIFICATION_FAILED", "The code does not match", id);
  }
}
