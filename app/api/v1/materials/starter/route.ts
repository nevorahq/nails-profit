import { materials } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { starterMaterials } from "@/domain/import-templates";
import { canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Seeds the starter material list, roadmap phase 4 "стартовые шаблоны
 * материалов".
 *
 * Names and units only — no prices. An invented purchase price is exactly the
 * plausible-but-wrong number section 8.8.1 refuses to produce, and it would be
 * worse than an empty catalogue: the costing would answer, confidently, with a
 * margin the owner never paid for.
 *
 * Existing names are skipped rather than duplicated, so pressing the button
 * twice, or pressing it after a price list has been imported, is safe.
 */
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

  const created = await withTenant(actor.organizationId, async (tx) => {
    const existing = await tx.select({ name: materials.name }).from(materials);
    const taken = new Set(existing.map((row) => row.name.trim().toLowerCase()));

    const wanted = starterMaterials.filter(
      (material) => !taken.has(material.name.trim().toLowerCase()),
    );
    if (wanted.length === 0) return [];

    const rows = await tx
      .insert(materials)
      .values(
        wanted.map((material) => ({
          organizationId: actor.organizationId,
          name: material.name,
          baseUnit: material.baseUnit,
          category: material.category,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      )
      .returning({ id: materials.id, name: materials.name });

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "material.starter_seeded",
      entityType: "material",
      entityId: actor.organizationId,
      after: { created: rows.length },
      requestId: id,
    });

    return rows;
  });

  return apiSuccess({ created: created.length, materials: created }, id, 201);
}

/** What the button would add, so the interface can name them before it does. */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  return apiSuccess(
    starterMaterials.map((material) => ({
      name: material.name,
      base_unit: material.baseUnit,
      category: material.category,
    })),
    id,
  );
}
