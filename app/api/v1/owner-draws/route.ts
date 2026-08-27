import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { ownerDraws } from "@/db/schema";
import { currencies } from "@/domain/money";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Money the owner took out for themselves.
 *
 * Owner-only through `expenses`, reading included — this is the most personal
 * number the product holds, and a manager has no business in it.
 *
 * Deliberately not an expense category. A draw does not reduce the profit it is
 * taken from; it moves money that was already earned. Recorded here it appears
 * in the cash flow and nowhere else, which is the only place it belongs.
 */
const drawShape = z.object({
  amount_minor: z.int().min(0),
  currency: z.enum(currencies),
  /** The day the money left. `YYYY-MM-DD`, like an expense's `spent_on`. */
  occurred_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().trim().max(500).optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "expenses", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read owner draws", id);
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const rows = await withTenant(caller.membership.organizationId, (tx) => {
    const conditions = [
      from ? gte(ownerDraws.occurredOn, from) : undefined,
      to ? lte(ownerDraws.occurredOn, to) : undefined,
    ].filter(Boolean);

    return tx
      .select({
        id: ownerDraws.id,
        amount_minor: ownerDraws.amountMinor,
        currency: ownerDraws.currency,
        occurred_on: ownerDraws.occurredOn,
        note: ownerDraws.note,
      })
      .from(ownerDraws)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(ownerDraws.occurredOn), asc(ownerDraws.createdAt));
  });

  return apiSuccess(rows, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot record owner draws", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = drawShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const data = parsed.data;

  const created = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx
      .insert(ownerDraws)
      .values({
        organizationId: actor.organizationId,
        amountMinor: data.amount_minor,
        currency: data.currency,
        ...(data.occurred_on ? { occurredOn: data.occurred_on } : {}),
        note: data.note ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "owner_draw.created",
      entityType: "owner_draw",
      entityId: row.id,
      after: { amount_minor: row.amountMinor, currency: row.currency, occurred_on: row.occurredOn },
      requestId: id,
    });

    return row;
  });

  return apiSuccess(
    {
      id: created.id,
      amount_minor: created.amountMinor,
      currency: created.currency,
      occurred_on: created.occurredOn,
      note: created.note,
    },
    id,
    201,
  );
}

export async function DELETE(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot record owner draws", id);
  }

  const drawId = new URL(request.url).searchParams.get("id");
  if (!drawId) return apiError(422, "VALIDATION_ERROR", "An id is required", id);

  /*
   * Deleted outright rather than archived, unlike an expense.
   *
   * A draw is a note to oneself about money already earned — it is in no
   * financial snapshot and no closed month depends on it. Keeping a struck-out
   * row would only make the cash flow harder to read.
   */
  const deleted = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx.delete(ownerDraws).where(eq(ownerDraws.id, drawId)).returning();
    if (!row) return null;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "owner_draw.deleted",
      entityType: "owner_draw",
      entityId: row.id,
      before: { amount_minor: row.amountMinor, occurred_on: row.occurredOn },
      requestId: id,
    });

    return row;
  });

  if (!deleted) return apiError(404, "OWNER_DRAW_NOT_FOUND", "No owner draw with this ID", id);

  return apiSuccess({ id: deleted.id }, id);
}
