import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { masterPayouts } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { currencies } from "@/domain/money";
import { can, canManageCatalogue } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { specialistExists } from "@/lib/payouts";

/**
 * Money handed to a master, marked on «К выплате».
 *
 * Owner-only through `expenses`, reading included — what one person was paid
 * is the same kind of fact as their salary, and a manager has no business in
 * it. A payout moves money and never profit: the work it pays for is already
 * a cost in the month it was done (`domain/payouts.ts`).
 */
const payoutShape = z.object({
  specialist_id: z.uuid(),
  amount_minor: z.int().min(1),
  currency: z.enum(currencies),
  /** The day the money was handed over, `YYYY-MM-DD`; absent is today. */
  paid_on: z.iso.date().optional(),
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
    return apiError(403, "FORBIDDEN", "This role cannot read payouts", id);
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const rows = await withTenant(caller.membership.organizationId, (tx) => {
    const conditions = [
      from ? gte(masterPayouts.paidOn, from) : undefined,
      to ? lte(masterPayouts.paidOn, to) : undefined,
    ].filter(Boolean);

    return tx
      .select({
        id: masterPayouts.id,
        specialist_id: masterPayouts.specialistId,
        amount_minor: masterPayouts.amountMinor,
        currency: masterPayouts.currency,
        paid_on: masterPayouts.paidOn,
        note: masterPayouts.note,
      })
      .from(masterPayouts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(masterPayouts.paidOn), asc(masterPayouts.createdAt));
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
    return apiError(403, "FORBIDDEN", "This role cannot record payouts", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = payoutShape.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }
  const data = parsed.data;

  const created = await withTenant(actor.organizationId, async (tx) => {
    // Archived cards included: a master who has left can still be owed.
    if (!(await specialistExists(tx, data.specialist_id))) return null;

    const [row] = await tx
      .insert(masterPayouts)
      .values({
        organizationId: actor.organizationId,
        specialistId: data.specialist_id,
        amountMinor: data.amount_minor,
        currency: data.currency,
        ...(data.paid_on ? { paidOn: data.paid_on } : {}),
        note: data.note || null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "master_payout.created",
      entityType: "master_payout",
      entityId: row.id,
      after: {
        specialist_id: row.specialistId,
        amount_minor: row.amountMinor,
        currency: row.currency,
        paid_on: row.paidOn,
      },
      requestId: id,
    });

    return row;
  });

  if (!created) return apiError(404, "SPECIALIST_NOT_FOUND", "No specialist with this ID", id);

  return apiSuccess(
    {
      id: created.id,
      specialist_id: created.specialistId,
      amount_minor: created.amountMinor,
      currency: created.currency,
      paid_on: created.paidOn,
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
    return apiError(403, "FORBIDDEN", "This role cannot record payouts", id);
  }

  const payoutId = new URL(request.url).searchParams.get("id");
  if (!payoutId || !z.uuid().safeParse(payoutId).success) {
    return apiError(422, "VALIDATION_ERROR", "An id is required", id);
  }

  /*
   * Deleted outright, like an owner's draw: a payout marked by mistake is in no
   * snapshot and no closed figure, and the audit row below keeps what it said.
   */
  const deleted = await withTenant(actor.organizationId, async (tx) => {
    const [row] = await tx.delete(masterPayouts).where(eq(masterPayouts.id, payoutId)).returning();
    if (!row) return null;

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "master_payout.deleted",
      entityType: "master_payout",
      entityId: row.id,
      before: { specialist_id: row.specialistId, amount_minor: row.amountMinor, paid_on: row.paidOn },
      requestId: id,
    });

    return row;
  });

  if (!deleted) return apiError(404, "PAYOUT_NOT_FOUND", "No payout with this ID", id);

  return apiSuccess({ id: deleted.id }, id);
}
