import { and, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { bookingHolds, clients } from "@/db/schema";
import { withTenant, type TenantTransaction } from "@/db/tenant";
import { normalizePhone } from "@/domain/phone";
import { parseBookingToken } from "@/domain/booking-token";
import { supportedLocales } from "@/i18n/messages";
import { loadBookingDraft, loadSlotContext } from "@/lib/availability-service";
import { recordAuditEvent } from "@/lib/audit";
import { issueManageLink, managePath } from "@/lib/booking-manage-link";
import { notifyBooking, scheduleBookingReminder } from "@/lib/booking-notifications";
import { isContactVerified } from "@/lib/booking-verification";
import { createBooking } from "@/lib/booking-service";
import { isExclusionViolation, isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, toFieldErrors, timedRoute } from "@/lib/http";
import { claimIdempotencyKey, fingerprintOf, recordIdempotentResult } from "@/lib/idempotency";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { findPublicOrganization } from "@/lib/public-booking";
import { publicNotFound, publicRequest } from "@/lib/public-booking-http";
import { PUBLIC_BOOKING_CREATE_RULE } from "@/lib/rate-limit";

const bodySchema = z.object({
  hold_token: z.string().min(40).max(300),
  service_id: z.uuid(),
  add_on_ids: z.array(z.uuid()).max(20).default([]),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable().optional(),
  locale: z.enum(supportedLocales),
  legal_accepted: z.literal(true),
});

async function findOrCreateClient(
  tx: TenantTransaction,
  input: {
    organizationId: string;
    name: string;
    normalizedPhone: string;
    email: string | null;
    locale: (typeof supportedLocales)[number];
    now: Date;
  },
) {
  const matches = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(
      or(
        eq(clients.normalizedPhone, input.normalizedPhone),
        input.email ? sql`lower(${clients.email}) = ${input.email}` : undefined,
      ),
    );
  const unique = [...new Set(matches.map((match) => match.id))];
  if (unique.length > 1) return null;

  if (unique.length === 1) {
    const [updated] = await tx
      .update(clients)
      .set({
        name: input.name,
        normalizedPhone: input.normalizedPhone,
        email: input.email,
        locale: input.locale,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        consentedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(clients.id, unique[0]))
      .returning({ id: clients.id });
    return updated.id;
  }

  const [created] = await tx
    .insert(clients)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      normalizedPhone: input.normalizedPhone,
      email: input.email,
      locale: input.locale,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      consentedAt: input.now,
    })
    .returning({ id: clients.id });
  return created.id;
}

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { id, refused } = publicRequest(
    request,
    PUBLIC_BOOKING_CREATE_RULE,
    "public_booking.create",
  );
  if (refused) return refused;

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(422, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }
  const normalizedPhone = normalizePhone(parsed.data.phone);
  if (!normalizedPhone) {
    return apiError(422, "INVALID_PHONE", "The phone number is invalid", id, {
      fieldErrors: [{ field: "phone", code: "invalid_format", message: "Invalid phone number" }],
    });
  }

  const { slug } = await params;
  const holdToken = parseBookingToken(parsed.data.hold_token, "hold");
  if (!holdToken) return publicNotFound(id);

  const organization = await findPublicOrganization(slug);
  if (!organization || organization.id !== holdToken.organizationId) return publicNotFound(id);

  const now = new Date();
  const fingerprint = fingerprintOf(parsed.data);

  try {
    const outcome = await withTenant(organization.id, async (tx) => {
      const claim = await claimIdempotencyKey(tx, {
        organizationId: organization.id,
        scope: "booking.public_create",
        key: idempotencyKey,
        fingerprint,
      });
      if (claim.status === "conflict") return { failure: "IDEMPOTENCY_CONFLICT" as const };
      if (claim.status === "replay" && claim.bookingId) {
        return {
          replay: claim.bookingId,
          manageToken: (
            await issueManageLink(tx, {
              organizationId: organization.id,
              bookingId: claim.bookingId,
              now,
            })
          ).token,
        };
      }
      if (claim.status === "replay") return { failure: "IDEMPOTENCY_CONFLICT" as const };

      const [hold] = await tx
        .select()
        .from(bookingHolds)
        .where(
          and(
            eq(bookingHolds.tokenHash, holdToken.tokenHash),
            eq(bookingHolds.status, "active"),
            gt(bookingHolds.expiresAt, now),
          ),
        )
        .limit(1);
      if (!hold) return { failure: "HOLD_EXPIRED" as const };

      const context = await loadSlotContext(tx, hold.locationId);
      if (!context || context.publicStatus !== "published") {
        return { failure: "BOOKING_PAUSED" as const };
      }

      const draft = await loadBookingDraft(tx, {
        serviceId: parsed.data.service_id,
        addOnIds: parsed.data.add_on_ids,
        specialistId: hold.specialistId,
      });
      if (!draft) return { failure: "SERVICE_NOT_BOOKABLE" as const };
      if (hold.endsAt.getTime() - hold.startsAt.getTime() !== draft.durationMinutes * 60_000) {
        return { failure: "HOLD_MISMATCH" as const };
      }

      // Section 7.2 step 7. Checked before the client record is touched: an
      // unverified request must not reach `findOrCreateClient`, which is where
      // an anonymous visitor would otherwise rewrite an existing client's name
      // and email on the strength of knowing their phone number.
      if (
        context.verificationMode === "code" &&
        !(await isContactVerified(tx, {
          holdId: hold.id,
          normalizedPhone,
          email: parsed.data.email ?? null,
          now,
        }))
      ) {
        return { failure: "VERIFICATION_REQUIRED" as const };
      }

      const clientId = await findOrCreateClient(tx, {
        organizationId: organization.id,
        name: parsed.data.name,
        normalizedPhone,
        email: parsed.data.email ?? null,
        locale: parsed.data.locale,
        now,
      });
      if (!clientId) return { failure: "CONTACT_CONFLICT" as const };

      const created = await createBooking(tx, {
        organizationId: organization.id,
        locationId: hold.locationId,
        specialistId: hold.specialistId,
        workplaceId: hold.workplaceId,
        clientId,
        interval: { start: hold.startsAt, end: hold.endsAt },
        source: "public_booking",
        confirmationMode: context.confirmationMode,
        confirmationTtlMinutes: context.confirmationTtlMinutes,
        lines: draft.lines,
        actorUserId: null,
        holdId: hold.id,
        now,
      });
      if (!created.ok) return { failure: "SLOT_UNAVAILABLE" as const };

      await recordIdempotentResult(tx, claim.id, created.bookingId);
      const manage = await issueManageLink(tx, {
        organizationId: organization.id,
        bookingId: created.bookingId,
        now,
      });

      await recordAuditEvent(tx, {
        organizationId: organization.id,
        actorUserId: null,
        eventType: "booking.created",
        entityType: "booking",
        entityId: created.bookingId,
        after: {
          source: "public_booking",
          location_id: hold.locationId,
          specialist_id: hold.specialistId,
          starts_at: hold.startsAt,
          ends_at: hold.endsAt,
          has_email: Boolean(parsed.data.email),
        },
        requestId: id,
      });
      await recordPilotProductEvent(tx, {
        organizationId: organization.id,
        eventName: "booking_started",
        actorUserId: null,
        actorRole: null,
        source: "api",
        entityType: "booking",
        entityId: created.bookingId,
      });
      if (created.status === "confirmed") {
        await recordPilotProductEvent(tx, {
          organizationId: organization.id,
          eventName: "booking_confirmed",
          actorUserId: null,
          actorRole: null,
          source: "api",
          entityType: "booking",
          entityId: created.bookingId,
        });
      }

      await notifyBooking(tx, {
        organizationId: organization.id,
        bookingId: created.bookingId,
        template:
          created.status === "confirmed" ? "booking.confirmed" : "booking.pending_confirmation",
      });
      // A request the studio has not answered is not something to remind about
      // yet; confirming it schedules the reminder.
      if (created.status === "confirmed") {
        await scheduleBookingReminder(tx, {
          organizationId: organization.id,
          bookingId: created.bookingId,
          locationId: hold.locationId,
          startsAt: hold.startsAt,
          now,
        });
      }

      return { bookingId: created.bookingId, status: created.status, manageToken: manage.token };
    });

    if ("failure" in outcome) {
      switch (outcome.failure) {
        case "IDEMPOTENCY_CONFLICT":
          return apiError(409, "IDEMPOTENCY_KEY_REUSED", "This key belongs to another request", id);
        case "HOLD_EXPIRED":
          return apiError(409, "HOLD_EXPIRED", "The slot hold has expired", id);
        case "BOOKING_PAUSED":
          return publicNotFound(id);
        case "HOLD_MISMATCH":
          return apiError(409, "HOLD_MISMATCH", "The held slot no longer matches the service", id);
        case "CONTACT_CONFLICT":
          return apiError(409, "CONTACT_CONFLICT", "The supplied contacts belong to different clients", id);
        case "SERVICE_NOT_BOOKABLE":
          return apiError(422, "SERVICE_NOT_BOOKABLE", "The service cannot be booked", id);
        case "VERIFICATION_REQUIRED":
          return apiError(403, "VERIFICATION_REQUIRED", "This contact has not been verified", id);
        case "SLOT_UNAVAILABLE":
          return apiError(409, "SLOT_UNAVAILABLE", "This slot is no longer free", id);
      }
    }

    if ("replay" in outcome) {
      return apiSuccess(
        {
          id: outcome.replay,
          replayed: true,
          manage_token: outcome.manageToken,
          manage_url: managePath(outcome.manageToken),
        },
        id,
      );
    }

    return apiSuccess(
      {
        id: outcome.bookingId,
        status: outcome.status,
        manage_token: outcome.manageToken,
        manage_url: `/booking/${outcome.manageToken}`,
      },
      id,
      201,
    );
  } catch (error) {
    if (
      isExclusionViolation(error) ||
      isUniqueViolation(error, "client_org_phone_idx") ||
      isUniqueViolation(error, "client_org_email_idx")
    ) {
      return apiError(409, "SLOT_OR_CONTACT_CONFLICT", "The booking could not be created", id);
    }
    throw error;
  }
}

/** Section 7.10 measures this route; see `timedRoute`. */
export const POST = timedRoute("public.booking.create", handlePost);
