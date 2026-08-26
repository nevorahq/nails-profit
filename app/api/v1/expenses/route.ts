import { eq } from "drizzle-orm";
import { z } from "zod";

import { expenses, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, canManageCatalogue } from "@/domain/rbac";
import { expenseCategories, isExpenseCategory } from "@/domain/expense-categories";
import { isCalendarDay, loadExpenses } from "@/lib/expenses";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * Recorded purchases: rent, a lamp, an ad, a box of gel — see the
 * comment on the `expense` table in `db/schema.ts`.
 *
 * Owner-only, reading included, by its own `expenses` capability in
 * `domain/rbac.ts`. The page hides the section for everyone else, but that is
 * decoration: section 6.1 is explicit that a hidden button is not access
 * control, so every handler below asks the matrix.
 */
/**
 * `YYYY-MM-DD`, and a day that exists. `z.string().date()` would take the shape
 * but not the calendar, and the column would end up holding 31 February.
 */
const calendarDay = z.string().refine(isCalendarDay, { message: "Expected a YYYY-MM-DD date" });

const createExpenseSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.enum(expenseCategories),
    // Optional: the form always sends it, and a caller that does not gets the
    // column's own CURRENT_DATE rather than a rejection.
    spent_on: calendarDay.optional(),
    // Minor units, like every other amount in the API: the browser converts once,
    // and no fractional currency reaches the database.
    amount_minor: z.int().min(0),
    note: z.string().trim().max(2000).optional(),
    /**
     * Rent, a subscription. Stored as one row with an interval rather than
     * repeated monthly — see the column's comment in `db/schema.ts`.
     */
    is_recurring: z.boolean().optional(),
    recurring_from: calendarDay.optional(),
    recurring_to: calendarDay.optional(),
  })
  .refine((value) => !value.is_recurring || (value.recurring_from ?? value.spent_on) !== undefined, {
    message: "A recurring expense needs a month to start from",
    path: ["recurring_from"],
  })
  .refine(
    (value) => !value.recurring_to || !value.recurring_from || value.recurring_to >= value.recurring_from,
    { message: "The end cannot precede the start", path: ["recurring_to"] },
  );

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "expenses", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read expenses", id);
  }

  /*
   * The same loader the page uses, with the same filters.
   *
   * This used to be its own query: no period, no category, ordered by the day
   * the row was written. Two answers to one question, and the one the API gave
   * was the one nobody wanted — a receipt from July entered today sorted after
   * August. A caller that passes nothing still gets the whole live ledger, so
   * the change takes nothing away.
   *
   * An unparseable date or a category nobody offers is ignored rather than
   * refused, exactly as on the page: a filter that does not exist is no filter,
   * and a hand-edited query string must not decide what the column is compared
   * against.
   */
  const params = new URL(request.url).searchParams;
  const category = params.get("category") ?? undefined;
  const rows = await loadExpenses(caller.membership.organizationId, {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    category: category && isExpenseCategory(category) ? category : undefined,
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
    return apiError(403, "FORBIDDEN", "This role cannot manage expenses", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createExpenseSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const expense = await withTenant(actor.organizationId, async (tx) => {
    // The organization's own currency, not a hardcoded "MDL": an organization on
    // EUR would otherwise get its expenses stamped in a currency it never uses,
    // and the amount would be silently wrong wherever the two are added up.
    const [organization] = await tx
      .select({ currency: organizations.currency })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    const [created] = await tx
      .insert(expenses)
      .values({
        organizationId: actor.organizationId,
        name: parsed.data.name,
        category: parsed.data.category,
        ...(parsed.data.spent_on ? { spentOn: parsed.data.spent_on } : {}),
        amountMinor: parsed.data.amount_minor,
        currency: organization?.currency ?? "MDL",
        note: parsed.data.note ?? null,
        isRecurring: parsed.data.is_recurring ?? false,
        // Falls back to the day of the purchase: a recurring expense entered
        // today starts today, and asking twice for the same date is a question
        // nobody wants.
        recurringFrom: parsed.data.is_recurring
          ? (parsed.data.recurring_from ?? parsed.data.spent_on ?? null)
          : null,
        recurringTo: parsed.data.is_recurring ? (parsed.data.recurring_to ?? null) : null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "expense.created",
      entityType: "expense",
      entityId: created.id,
      after: {
        name: created.name,
        category: created.category,
        spent_on: created.spentOn,
        amount_minor: created.amountMinor,
        is_recurring: created.isRecurring,
        recurring_from: created.recurringFrom,
      },
      requestId: id,
    });

    return created;
  });

  return apiSuccess(
    {
      id: expense.id,
      name: expense.name,
      category: expense.category,
      spent_on: expense.spentOn,
      amount_minor: expense.amountMinor,
      currency: expense.currency,
      note: expense.note,
      is_recurring: expense.isRecurring,
      recurring_from: expense.recurringFrom,
      recurring_to: expense.recurringTo,
    },
    id,
    201,
  );
}
