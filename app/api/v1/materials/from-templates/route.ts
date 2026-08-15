import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { isMaterialProfile } from "@/domain/material-provenance";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import {
  claimIdempotencyKey,
  fingerprintOf,
  recordIdempotentOutcome,
} from "@/lib/idempotency";
import { createMaterialsFromTemplates } from "@/lib/material-templates";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents, recordPilotProductEvent } from "@/lib/pilot-events";

/**
 * Fast Setup's one write, epic E3.1 §F3: fourteen materials from fourteen
 * prices, in a single request.
 *
 * One request rather than fourteen because the whole claim of the screen is
 * that a first catalogue takes minutes, and a browser that fires fourteen
 * requests over a phone connection fails halfway through often enough to
 * matter — leaving a half-built catalogue and no way to tell which half.
 */
const IDEMPOTENCY_SCOPE = "materials.from_templates";

const schema = z.object({
  items: z
    .array(
      z.object({
        template_id: z.uuid(),
        package_price_minor: z.int().min(0),
        /** Required whenever the template states no packaging of its own. */
        package_size_milli_units: z.int().positive().optional(),
        currency: z.enum(["MDL", "EUR"]).default("MDL"),
      }),
    )
    .min(1)
    .max(60),
  /** Recorded with the completion event; the screen the owner came from. */
  profile: z.string().optional(),
  /** How long the owner spent on the screen, for the friction measurement. */
  duration_ms: z.int().min(0).max(24 * 60 * 60 * 1000).optional(),
});

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "materials")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage materials", id);
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return apiError(422, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const profile = parsed.data.profile;
  if (profile !== undefined && !isMaterialProfile(profile)) {
    return apiError(422, "UNKNOWN_PROFILE", "No such work profile", id);
  }

  const fingerprint = fingerprintOf(parsed.data.items);

  const outcome = await withTenant(actor.organizationId, async (tx) => {
    const claim = await claimIdempotencyKey(tx, {
      organizationId: actor.organizationId,
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      fingerprint,
    });

    if (claim.status === "conflict") return { failure: "IDEMPOTENCY_CONFLICT" as const };
    if (claim.status === "replay") return { replay: claim.result };

    const result = await createMaterialsFromTemplates(
      tx,
      { organizationId: actor.organizationId, userId: actor.userId },
      parsed.data.items.map((item) => ({
        templateId: item.template_id,
        packagePriceMinor: item.package_price_minor,
        packageSizeMilliUnits: item.package_size_milli_units,
        currency: item.currency,
      })),
    );

    const answer = {
      created: result.created,
      skipped_existing: result.skipped_existing,
      conflicts: result.conflicts,
    };

    await recordIdempotentOutcome(tx, claim.id, answer);

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.created_from_templates",
      entityType: "material",
      entityId: actor.organizationId,
      after: { created: result.created, skipped_existing: result.skipped_existing },
      requestId: id,
    });

    for (const materialId of result.material_ids) {
      await recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "material_saved",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "material",
        entityId: materialId,
        // Booleans and counts only: no material names, no amounts. `template`
        // is what makes this row distinguishable from a hand-typed one, and
        // `fields_prefilled` is the friction number the screen exists to move.
        metadata: { template: true, bulk_paste: false, fields_prefilled: 4 },
      });
    }

    if (result.created > 0) {
      await recordPilotProductEvent(tx, {
        organizationId: actor.organizationId,
        eventName: "fast_setup_completed",
        actorUserId: actor.userId,
        actorRole: actor.role,
        source: "api",
        entityType: "organization",
        entityId: actor.organizationId,
        metadata: {
          materials_created: result.created,
          duration_ms: parsed.data.duration_ms ?? null,
          manicure: profile === "manicure",
          pedicure: profile === "pedicure",
          extension: profile === "extension",
        },
      });
    }

    await recordCompletedServiceCostEvents(tx, actor);

    return { answer };
  });

  if ("failure" in outcome) {
    return apiError(409, "IDEMPOTENCY_KEY_REUSED", "This key was used for a different request", id);
  }
  if ("replay" in outcome) {
    return apiSuccess(outcome.replay ?? { created: 0, skipped_existing: 0, conflicts: [] }, id, 201);
  }

  return apiSuccess(outcome.answer, id, 201);
}
