import { eq } from "drizzle-orm";
import { z } from "zod";

import { expenses } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { canManageCatalogue } from "@/domain/rbac";
import { expenseCategories } from "@/domain/expense-categories";
import { isCalendarDay } from "@/lib/expenses";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

const calendarDay = z.string().refine(isCalendarDay, { message: "Expected a YYYY-MM-DD date" });

const patchExpenseSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.enum(expenseCategories).optional(),
  spent_on: calendarDay.optional(),
  amount_minor: z.int().min(0).optional(),
  // Nullable, unlike the others: clearing a note is a real edit, and an
  // `undefined` that means "leave it" cannot also mean "empty it".
  note: z.string().trim().max(2000).nullable().optional(),
  /**
   * Ending a recurring expense, which is not the same as deleting it.
   *
   * Archiving takes the row out of every month it ever applied to — right for
   * something entered by mistake, wrong for rent that really was paid until
   * August. Closing the interval leaves the past exactly as it was reported and
   * stops the future.
   */
  recurring_to: calendarDay.nullable().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage expenses", reqId);
  }

  const body = await request.json().catch(() => null);
  const parsed = patchExpenseSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", reqId, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const { id } = await context.params;

  const updated = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(expenses).where(eq(expenses.id, id)).limit(1);
    if (!existing || existing.archivedAt) return null;

    const [expense] = await tx
      .update(expenses)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
        ...(parsed.data.spent_on !== undefined ? { spentOn: parsed.data.spent_on } : {}),
        ...(parsed.data.amount_minor !== undefined ? { amountMinor: parsed.data.amount_minor } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note || null } : {}),
        ...(parsed.data.recurring_to !== undefined ? { recurringTo: parsed.data.recurring_to } : {}),
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "expense.updated",
      entityType: "expense",
      entityId: expense.id,
      before: {
        name: existing.name,
        category: existing.category,
        spent_on: existing.spentOn,
        amount_minor: existing.amountMinor,
        note: existing.note,
        recurring_to: existing.recurringTo,
      },
      after: {
        name: expense.name,
        category: expense.category,
        spent_on: expense.spentOn,
        amount_minor: expense.amountMinor,
        note: expense.note,
        recurring_to: expense.recurringTo,
      },
      requestId: reqId,
    });

    return expense;
  });

  if (!updated) {
    return apiError(404, "EXPENSE_NOT_FOUND", "No expense with this ID", reqId);
  }

  return apiSuccess(
    {
      id: updated.id,
      name: updated.name,
      category: updated.category,
      spent_on: updated.spentOn,
      amount_minor: updated.amountMinor,
      currency: updated.currency,
      note: updated.note,
      is_recurring: updated.isRecurring,
      recurring_from: updated.recurringFrom,
      recurring_to: updated.recurringTo,
    },
    reqId,
  );
}

/** Archives rather than deletes, for the reason given on the table. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const reqId = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", reqId);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", reqId);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "expenses")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage expenses", reqId);
  }

  const { id } = await context.params;

  const archived = await withTenant(actor.organizationId, async (tx) => {
    const [existing] = await tx.select().from(expenses).where(eq(expenses.id, id)).limit(1);
    if (!existing || existing.archivedAt) return null;

    const [expense] = await tx
      .update(expenses)
      .set({ archivedAt: new Date(), updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(expenses.id, id))
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "expense.archived",
      entityType: "expense",
      entityId: expense.id,
      before: { name: existing.name, amount_minor: existing.amountMinor },
      after: { archived: true },
      requestId: reqId,
    });

    return expense;
  });

  if (!archived) {
    return apiError(404, "EXPENSE_NOT_FOUND", "No expense with this ID", reqId);
  }

  return apiSuccess({ id: archived.id }, reqId);
}
