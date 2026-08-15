import { and, desc, gte, lte } from "drizzle-orm";

import { ExpenseLedger } from "@/components/expense-ledger";
import { OwnerDrawLedger, type OwnerDrawRow } from "@/components/owner-draw-ledger";
import { ToolIcon } from "@/components/icons";
import { expenseCategories, isExpenseCategory } from "@/domain/expense-categories";
import { can } from "@/domain/rbac";
import { getTranslator } from "@/i18n/t";
import { loadExpenses } from "@/lib/expenses";
import { ownerDraws } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { requireWorkspace } from "@/lib/workspace";

/**
 * The expense ledger: what the business paid for, recorded as lump sums.
 *
 * This replaces the material catalogue that answered on `/app/materials`. The
 * materials themselves are untouched — the API, the recipes and the CSV import
 * all still have them — but they are no longer a section of the interface, and
 * `lib/materials.ts` is where their loader lives now.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; category?: string }>;
}) {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);

  // Owner alone, reading included: the ledger holds rent and payroll. Everyone
  // else is turned away here and again by every handler under
  // `app/api/v1/expenses` — section 6.1 is explicit that hiding the interface
  // is not access control, so the navigation dropping the link is decoration
  // over this check, not a substitute for it.
  if (!can(membership.role, "expenses", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("expenses.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;
  // A category nobody offers is no filter at all — a hand-edited query string
  // must not decide what the enum column is compared against.
  const category = filters.category && isExpenseCategory(filters.category) ? filters.category : undefined;
  const rows = await loadExpenses(membership.organizationId, {
    from: filters.from,
    to: filters.to,
    category,
  });

  /*
   * The owner's draws share this page's period filter but not its category
   * one: a draw has no category, and pretending otherwise would be the same
   * mistake that put them under `payroll` in the first place.
   */
  const draws: OwnerDrawRow[] = await withTenant(membership.organizationId, (tx) => {
    const bounds = [
      filters.from ? gte(ownerDraws.occurredOn, filters.from) : undefined,
      filters.to ? lte(ownerDraws.occurredOn, filters.to) : undefined,
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
      .where(bounds.length > 0 ? and(...bounds) : undefined)
      .orderBy(desc(ownerDraws.occurredOn));
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point at
          the panel `components/expense-ledger.tsx` renders further down; the
          click handling that opens (and, for either anchor, closes) it lives
          there, since this is a Server Component and cannot hold it.
        */}
        <a className="primary-button calendar-create" href="#add-expense">
          <ToolIcon name="plus" />
          {t("expenses.addTitle")}
        </a>
        <a
          className="header-action"
          href="#add-expense"
          aria-label={t("expenses.addTitle")}
          data-label-closed={t("expenses.addTitle")}
          data-label-open={t("expenses.hideAddTitle")}
        >
          <ToolIcon name="plus" />
          <ToolIcon name="minus" />
        </a>
      </header>

      {/*
        The same toolbar `/app/visits` carries, down to the classes: a `details`
        that folds the form away, and `.visit-filters` so the panel drops into
        the flow rather than floating right — the trigger sits at the toolbar's
        left edge here too, next to the sidebar. A plain GET form, so the
        filter lives in the URL and survives a reload, a bookmark and the
        `router.refresh()` that follows every edit.
      */}
      <nav className="calendar-toolbar" aria-label={t("filters.title")}>
        <details className="calendar-filters visit-filters">
          <summary>
            <ToolIcon name="filter" />
            {t("filters.title")}
          </summary>
          <form className="inline-form" method="get">
            <label>
              {t("filters.from")}
              <input type="date" name="from" defaultValue={filters.from ?? ""} />
            </label>
            <label>
              {t("filters.to")}
              <input type="date" name="to" defaultValue={filters.to ?? ""} />
            </label>
            <label>
              {t("expenses.category")}
              <select name="category" defaultValue={category ?? ""}>
                <option value="">{t("filters.all")}</option>
                {expenseCategories.map((name) => (
                  <option key={name} value={name}>
                    {t(`expenses.category.${name}`)}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondary-button" type="submit">
              {t("filters.apply")}
            </button>
          </form>
        </details>
      </nav>

      <ExpenseLedger expenses={rows} locale={locale} />
      <OwnerDrawLedger
        draws={draws}
        currency={currency}
        locale={locale}
        canEdit={can(membership.role, "expenses", "write")}
      />
    </main>
  );
}
