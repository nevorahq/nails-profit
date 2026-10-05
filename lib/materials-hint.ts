import { and, eq, gte, isNull, lt } from "drizzle-orm";

import { expenses, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { materialsHint, materialsHintMonths } from "@/domain/materials-hint";
import { loadMaterialsModes, monthIn } from "@/lib/materials-mode";

/**
 * The figure «По вашим закупкам ≈ X на визит» offers, from the studio's own
 * ledger and visits (`domain/materials-hint.ts`).
 *
 * Months are the studio's, as everywhere the report is: a visit closed at a
 * quarter past midnight on the first belongs to the month its owner sees it
 * in. So the visits are read a day wider than the months in UTC and placed by
 * their own zone here, which is three months of one timestamp column.
 */
export async function loadMaterialsHint(
  tx: TenantTransaction,
  options: Readonly<{ organizationId: string; currency: string; at?: Date }>,
): Promise<number | null> {
  const modes = await loadMaterialsModes(tx, options.organizationId);
  const months = materialsHintMonths(monthIn(options.at ?? new Date(), modes.timezone));

  const widenedFrom = new Date(`${months[0]}-01T00:00:00.000Z`);
  widenedFrom.setUTCDate(widenedFrom.getUTCDate() - 1);
  const widenedTo = new Date(`${months.at(-1)}-01T00:00:00.000Z`);
  widenedTo.setUTCMonth(widenedTo.getUTCMonth() + 1);
  widenedTo.setUTCDate(widenedTo.getUTCDate() + 1);

  const closed = await tx
    .select({ completedAt: visits.completedAt })
    .from(visits)
    .where(
      and(
        eq(visits.currency, options.currency as typeof visits.$inferSelect.currency),
        gte(visits.completedAt, widenedFrom),
        lt(visits.completedAt, widenedTo),
      ),
    );
  const inMonths = new Set(months);
  const closedVisits = closed.filter((row) => inMonths.has(monthIn(row.completedAt, modes.timezone))).length;

  const ledger = await tx
    .select({
      id: expenses.id,
      name: expenses.name,
      category: expenses.category,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
      spentOn: expenses.spentOn,
      isRecurring: expenses.isRecurring,
      recurringFrom: expenses.recurringFrom,
      recurringTo: expenses.recurringTo,
    })
    .from(expenses)
    .where(isNull(expenses.archivedAt));

  return materialsHint({ expenses: ledger, closedVisits, months, currency: options.currency });
}
