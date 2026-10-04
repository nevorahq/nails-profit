import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { openingSetupProblems } from "@/domain/opening-setup";
import { can } from "@/domain/rbac";
import { parseLocalTime } from "@/domain/timezone";
import { isPublicBookingEnabled } from "@/env";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { saveOpeningSetup } from "@/lib/opening-setup";

/**
 * «Ваш прайс и часы» — the prices and the week a studio opens on.
 *
 * One endpoint rather than the services and availability ones in turn, because
 * the answer it carries is a single yes: these prices, this week, and — when
 * asked — open the page. Saved as separate requests, a failure halfway would
 * leave a page open on prices the owner never confirmed, which is the exact
 * thing this screen exists to prevent.
 */
const serviceSchema = z
  .object({
    id: z.uuid().optional(),
    key: z.string().trim().min(1).max(40).optional(),
    price_minor: z.int(),
    duration_minutes: z.int(),
  })
  .refine((service) => (service.id === undefined) !== (service.key === undefined), {
    message: "Send either the id of a service or the key of a catalogue kind",
    path: ["id"],
  });

const schema = z.object({
  services: z.array(serviceSchema).max(20),
  archive_service_ids: z.array(z.uuid()).max(20).default([]),
  workweek: z
    .object({
      weekdays: z.array(z.int().min(1).max(7)).max(7),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .nullable()
    .default(null),
  open_booking: z.boolean().default(false),
});

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  // The terms a studio opens on are the owner's to set, as its other
  // organization-wide settings are (section 6.1).
  if (!can(actor.role, "organization_settings", "write")) {
    return apiError(403, "FORBIDDEN", "This role cannot set the studio's opening terms", id);
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }
  const body = parsed.data;

  const week = body.workweek
    ? {
        weekdays: [...new Set(body.workweek.weekdays)].sort((a, b) => a - b),
        startMinute: parseLocalTime(body.workweek.start),
        endMinute: body.workweek.end === "24:00" ? 24 * 60 : parseLocalTime(body.workweek.end),
      }
    : null;
  const problems = openingSetupProblems({
    services: body.services.map((service) => ({
      priceMinor: service.price_minor,
      durationMinutes: service.duration_minutes,
    })),
    week,
  });
  if (problems.length > 0) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: problems.map((problem) => ({ field: problem.field, code: problem.code, message: problem.code })),
    });
  }

  // The operator's switch stays above the owner's: with public booking off for
  // the deployment, there is no page to open.
  if (body.open_booking && !isPublicBookingEnabled()) {
    return apiError(409, "PUBLIC_BOOKING_UNAVAILABLE", "Online booking is not available here yet", id);
  }

  const outcome = await withTenant(actor.organizationId, (tx) =>
    saveOpeningSetup(
      tx,
      actor,
      {
        services: body.services.map((service) => ({
          id: service.id,
          key: service.key,
          priceMinor: service.price_minor,
          durationMinutes: service.duration_minutes,
        })),
        archiveServiceIds: body.archive_service_ids,
        week:
          week && week.startMinute !== null && week.endMinute !== null
            ? { weekdays: week.weekdays, startMinute: week.startMinute, endMinute: week.endMinute }
            : null,
        openBooking: body.open_booking,
      },
      id,
    ),
  );

  if ("failure" in outcome) {
    switch (outcome.failure) {
      case "SERVICE_NOT_FOUND":
        return apiError(404, "SERVICE_NOT_FOUND", "A service in the request is not this studio's", id);
      case "UNKNOWN_SERVICE_KIND":
        return apiError(422, "VALIDATION_ERROR", "Not a service kind the catalogue knows", id);
      case "NO_OWNER_CARD":
        return apiError(409, "NO_OWNER_CARD", "Nobody here works under the owner's account to hold a week", id);
      case "LOCATION_NOT_FOUND":
        return apiError(409, "LOCATION_NOT_FOUND", "The studio has no address to open", id);
    }
  }

  return apiSuccess({ published: outcome.published }, id);
}
