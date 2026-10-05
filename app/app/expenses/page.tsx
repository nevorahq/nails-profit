import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";

import { ExpenseLedger } from "@/components/expense-ledger";
import { LaborCostManager, type LaborCostRow } from "@/components/labor-cost-manager";
import { MoneyQuestion } from "@/components/money-questions";
import { OwnerDrawLedger, type OwnerDrawRow } from "@/components/owner-draw-ledger";
import { PaymentMethodManager, type PaymentMethodRow } from "@/components/payment-method-manager";
import { TaxRuleManager, type TaxRuleRowView } from "@/components/tax-rule-manager";
import { ToolIcon } from "@/components/icons";
import { expenseCategories, isExpenseCategory } from "@/domain/expense-categories";
import { can } from "@/domain/rbac";
import { todayIn } from "@/domain/report-period";
import { formatLocalDate } from "@/domain/timezone";
import { getTranslator } from "@/i18n/t";
import { registerOf } from "@/i18n/lexicon";
import { loadDashboard } from "@/lib/dashboard";
import { loadExpenses } from "@/lib/expenses";
import { loadMaterialsModes, monthIn } from "@/lib/materials-mode";
import { loadMoneyAnswers } from "@/lib/money-answers";
import { loadMonthGuide } from "@/lib/onboarding";
import { monthBounds, monthOf } from "@/lib/period";
import { laborCostRules, organizations, ownerDraws, paymentMethods, specialists, taxRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { requireWorkspace } from "@/lib/workspace";

/**
 * «Деньги»: what the business paid for, what the owner took out, and the three
 * settings that decide how much of a visit's price the studio keeps — the taxes
 * on it, the bank's fee on the way in, and what the work is paid.
 *
 * The last three lived in Настройки, beside the studio's name and its
 * subscription, where an owner looking for why the month came out the way it
 * did never went. They are read here with the ledger they sit beside.
 *
 * Since the material engine was removed this is where a crate of gel is
 * recorded, and the only place it reaches the accounts: one amount on the day
 * it was bought, counted as ordinary overhead by
 * `domain/expense-classes.ts` rather than held back against a consumption that
 * no longer happens.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; category?: string }>;
}) {
  const workspace = await requireWorkspace();
  const { membership, locale, currency, businessType, detailedAnalytics, timezone } = workspace;
  const register = registerOf(workspace);
  const t = getTranslator(locale, register);

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

  /*
   * Where «Расчёт месяца» stands, so the first expense of a month that has none
   * can say what it just made possible.
   *
   * Null for a studio still working towards its first visit — it has no month
   * to correct yet — and null again once both steps are done, which is most of
   * this page's life: the ledger is a weekly habit, not a setup screen.
   */
  const materials = await withTenant(membership.organizationId, (tx) =>
    loadMaterialsModes(tx, membership.organizationId),
  );

  const monthGuide = await withTenant(membership.organizationId, (tx) =>
    loadMonthGuide(tx, { month: monthOf(new Date()), currency, organizationId: membership.organizationId }),
  );

  // The studio's date, the first a versioned rule can change from.
  const asOf = new Date();
  const today = formatLocalDate(todayIn(asOf, timezone));
  const canEdit = can(membership.role, "expenses", "write");

  /*
   * The two questions the report is before until they are answered, the tax
   * rates and the payment methods. Read for every owner: whether a visit is
   * taxed is not an advanced question, whatever the report's wording is.
   */
  const { answers, taxes, methods } = await withTenant(membership.organizationId, async (tx) => {
    const answers = await loadMoneyAnswers(tx, membership.organizationId);

    const taxes: TaxRuleRowView[] = (
      await tx
        .select({
          id: taxRules.id,
          kind: taxRules.kind,
          basis_points: taxRules.basisPoints,
          remittable: taxRules.remittable,
          active_from: taxRules.activeFrom,
          active_to: taxRules.activeTo,
        })
        .from(taxRules)
        .orderBy(asc(taxRules.activeFrom))
    ).map((rule) => ({
      ...rule,
      active_from: rule.active_from.toISOString(),
      active_to: rule.active_to?.toISOString() ?? null,
    }));

    const methods: PaymentMethodRow[] = await tx
      .select({
        id: paymentMethods.id,
        name: paymentMethods.name,
        kind: paymentMethods.kind,
        commission_basis_points: paymentMethods.commissionBasisPoints,
        fixed_fee_minor: paymentMethods.fixedFeeMinor,
        is_default: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(isNull(paymentMethods.archivedAt))
      .orderBy(asc(paymentMethods.createdAt));

    return { answers, taxes, methods };
  });

  /*
   * The labour rules, whom they are for, and what the owner has already booked
   * themselves this month — only where «Подробная финансовая аналитика» is on,
   * because economic profit and «Можно вывести» are what they feed, and those
   * lines are drawn only there. `tests/owner-wage-reachable.test.ts` holds the
   * report and this block together.
   *
   * The last of those goes into the form as its starting value: it is the
   * market rate the owner charged their own visits at, and it is the figure
   * that makes the add-back and the imputed wage cancel exactly. Read through
   * `loadDashboard` rather than a query of its own, so it is the same
   * aggregate the monthly report shows.
   */
  const canReadLabour = detailedAnalytics;
  const labour = canReadLabour
    ? await withTenant(membership.organizationId, async (tx) => {
        const rules: LaborCostRow[] = (
          await tx
            .select({
              id: laborCostRules.id,
              recipient: laborCostRules.recipient,
              specialist_id: laborCostRules.specialistId,
              label: laborCostRules.label,
              basis: laborCostRules.basis,
              amount_minor: laborCostRules.amountMinor,
              basis_points: laborCostRules.basisPoints,
              payroll_tax_basis_points: laborCostRules.payrollTaxBasisPoints,
              active_from: laborCostRules.activeFrom,
              active_to: laborCostRules.activeTo,
            })
            .from(laborCostRules)
            .orderBy(asc(laborCostRules.activeFrom))
        ).map((rule) => ({
          ...rule,
          active_from: rule.active_from.toISOString(),
          active_to: rule.active_to?.toISOString() ?? null,
        }));

        const people = await tx
          .select({ id: specialists.id, name: specialists.name })
          .from(specialists)
          .where(isNull(specialists.archivedAt))
          .orderBy(asc(specialists.name));

        const [organization] = await tx
          .select({ reserveMinor: organizations.withdrawalReserveMinor })
          .from(organizations)
          .where(eq(organizations.id, membership.organizationId))
          .limit(1);

        const { from, to } = monthBounds(monthOf(new Date()));
        const dashboard = await loadDashboard(tx, { from, to }, locale);

        return {
          rules,
          people,
          reserveMinor: organization?.reserveMinor ?? 0,
          suggestedOwnerWageMinor: dashboard.metrics.principalLabourMinor,
        };
      })
    : null;

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
        The last folded filter panel in the product: a `details` that hides the
        form until it is asked for. The calendar, the dashboard and the visit
        list have all put theirs open on the bar; this one has a category select
        as well as a period, and moving it has not been asked for. A plain GET
        form, so the filter lives in the URL and survives a reload, a bookmark
        and the `router.refresh()` that follows every edit.
      */}
      <nav className="calendar-toolbar" aria-label={t("filters.title")}>
        <details className="calendar-filters">
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

      <ExpenseLedger
        expenses={rows}
        locale={locale}
        currency={currency}
        businessType={businessType}
        detailedAnalytics={detailedAnalytics}
        monthGuide={monthGuide}
        materialsPeriods={materials.periods}
        currentMonth={monthIn(new Date(), materials.timezone)}
      />
      <OwnerDrawLedger draws={draws} currency={currency} locale={locale} canEdit={canEdit} />

      {/*
        Each question stands over the block that keeps its answer, at the
        anchor the month's guide and the report's «указать» link to. Once
        answered it gives way to the block alone, which is where a rate is
        changed from then on.
      */}
      <MoneyQuestion
        question="taxes"
        answered={answers.taxes || !canEdit}
        locale={locale}
        businessType={businessType}
        monthGuide={monthGuide}
      />
      <TaxRuleManager
        rules={taxes}
        today={today}
        asOf={asOf.toISOString()}
        timezone={timezone}
        locale={locale}
        canEdit={canEdit}
      />
      <MoneyQuestion
        question="payments"
        answered={answers.payments || !canEdit}
        locale={locale}
        businessType={businessType}
        monthGuide={monthGuide}
      />
      <PaymentMethodManager methods={methods} currency={currency} locale={locale} canEdit={canEdit} />
      {labour && (
        <div id="labour">
          <LaborCostManager
            rules={labour.rules}
            specialists={labour.people}
            currency={currency}
            locale={locale}
            businessType={businessType}
            reserveMinor={labour.reserveMinor}
            canEdit={canEdit}
            suggestedOwnerWageMinor={labour.suggestedOwnerWageMinor}
            today={today}
            asOf={asOf.toISOString()}
            timezone={timezone}
          />
        </div>
      )}
    </main>
  );
}
