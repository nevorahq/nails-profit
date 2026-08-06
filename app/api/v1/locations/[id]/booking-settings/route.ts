import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { bookingSettings, locations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { bookingModuleRefusal } from "@/lib/booking-http";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Booking configuration for one location, roadmap section 7.4.
 *
 * Every field narrows what the availability engine may offer, and each has a
 * reason a salon can state out loud: a lead time so nobody books the slot that
 * starts in four minutes, an advance window so next year's calendar is not a
 * commitment, buffers for cleaning between clients, and a confirmation mode for
 * studios that want to see a request before it becomes an appointment.
 *
 * The bounds are duplicated as CHECK constraints in the database. That is not
 * redundancy: this endpoint is one writer, and a limit that only exists in a
 * Zod schema is a limit an import or a fix-up script can walk straight past.
 */
const settingsSchema = z
  .object({
    public_status: z.enum(["draft", "published", "paused"]).optional(),
    slot_step_minutes: z.union([
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(20),
      z.literal(30),
      z.literal(60),
    ]).optional(),
    min_lead_minutes: z.int().min(0).max(43_200).optional(),
    max_advance_days: z.int().min(1).max(365).optional(),
    buffer_before_minutes: z.int().min(0).max(240).optional(),
    buffer_after_minutes: z.int().min(0).max(240).optional(),
    confirmation_mode: z.enum(["instant", "manual"]).optional(),
    confirmation_ttl_minutes: z.int().min(15).max(1_440).optional(),
    verification_mode: z.enum(["off", "code"]).optional(),
    verification_ttl_minutes: z.int().min(3).max(60).optional(),
    reminder_lead_minutes: z.int().min(0).max(10_080).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestIdentifier = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) {
    return apiError(401, "UNAUTHENTICATED", "Authentication is required", requestIdentifier);
  }
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", requestIdentifier);
  }

  const actor = caller.membership;
  // Publishing a public page is an organization-level decision, section 6.1.
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot change booking settings", requestIdentifier);
  }
  const disabled = await bookingModuleRefusal(actor.organizationId, requestIdentifier, "write");
  if (disabled) return disabled;

  const body = await request.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", requestIdentifier, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id: locationId } = await context.params;

  const updated = await withTenant(actor.organizationId, async (tx) => {
    const [location] = await tx.select().from(locations).where(eq(locations.id, locationId)).limit(1);
    if (!location) return null;

    const [existing] = await tx
      .select()
      .from(bookingSettings)
      .where(eq(bookingSettings.locationId, locationId))
      .limit(1);
    if (!existing) return null;

    const [settings] = await tx
      .update(bookingSettings)
      .set({
        ...(parsed.data.public_status !== undefined ? { publicStatus: parsed.data.public_status } : {}),
        ...(parsed.data.slot_step_minutes !== undefined
          ? { slotStepMinutes: parsed.data.slot_step_minutes }
          : {}),
        ...(parsed.data.min_lead_minutes !== undefined
          ? { minLeadMinutes: parsed.data.min_lead_minutes }
          : {}),
        ...(parsed.data.max_advance_days !== undefined
          ? { maxAdvanceDays: parsed.data.max_advance_days }
          : {}),
        ...(parsed.data.buffer_before_minutes !== undefined
          ? { bufferBeforeMinutes: parsed.data.buffer_before_minutes }
          : {}),
        ...(parsed.data.buffer_after_minutes !== undefined
          ? { bufferAfterMinutes: parsed.data.buffer_after_minutes }
          : {}),
        ...(parsed.data.confirmation_mode !== undefined
          ? { confirmationMode: parsed.data.confirmation_mode }
          : {}),
        ...(parsed.data.confirmation_ttl_minutes !== undefined
          ? { confirmationTtlMinutes: parsed.data.confirmation_ttl_minutes }
          : {}),
        ...(parsed.data.verification_mode !== undefined
          ? { verificationMode: parsed.data.verification_mode }
          : {}),
        ...(parsed.data.verification_ttl_minutes !== undefined
          ? { verificationTtlMinutes: parsed.data.verification_ttl_minutes }
          : {}),
        ...(parsed.data.reminder_lead_minutes !== undefined
          ? { reminderLeadMinutes: parsed.data.reminder_lead_minutes }
          : {}),
        updatedBy: actor.userId,
        updatedAt: new Date(),
        version: sql`${bookingSettings.version} + 1`,
      })
      .where(eq(bookingSettings.locationId, locationId))
      .returning();

    // Publishing or pausing a public booking page is exactly the kind of change
    // that has to be explicable afterwards.
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "booking_settings.updated",
      entityType: "booking_settings",
      entityId: settings.id,
      before: {
        public_status: existing.publicStatus,
        confirmation_mode: existing.confirmationMode,
        verification_mode: existing.verificationMode,
      },
      after: {
        public_status: settings.publicStatus,
        confirmation_mode: settings.confirmationMode,
        verification_mode: settings.verificationMode,
      },
      requestId: requestIdentifier,
    });

    return settings;
  });

  if (!updated) {
    return apiError(404, "LOCATION_NOT_FOUND", "No location with this ID", requestIdentifier);
  }

  return apiSuccess(
    {
      location_id: updated.locationId,
      public_status: updated.publicStatus,
      slot_step_minutes: updated.slotStepMinutes,
      min_lead_minutes: updated.minLeadMinutes,
      max_advance_days: updated.maxAdvanceDays,
      buffer_before_minutes: updated.bufferBeforeMinutes,
      buffer_after_minutes: updated.bufferAfterMinutes,
      confirmation_mode: updated.confirmationMode,
      confirmation_ttl_minutes: updated.confirmationTtlMinutes,
      verification_mode: updated.verificationMode,
      verification_ttl_minutes: updated.verificationTtlMinutes,
      reminder_lead_minutes: updated.reminderLeadMinutes,
      version: updated.version,
    },
    requestIdentifier,
  );
}
