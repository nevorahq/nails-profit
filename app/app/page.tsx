import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { FirstRun } from "@/components/first-run";
import { MetricIcon, ToolIcon } from "@/components/icons";
import { MonthSetupPanel, OnboardingPanel } from "@/components/onboarding-panel";
import { PeriodFilter } from "@/components/period-filter";
import { ProfitBars } from "@/components/profit-bars";
import { ProfitTrendChart } from "@/components/profit-trend-chart";
import { WorkspaceSetup } from "@/components/workspace-setup";
import { db } from "@/db";
import { memberships, organizations, pilotEnrollments, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { buildProfitTrend } from "@/domain/dashboard-metrics";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { isPilotAccessEnforced } from "@/env";
import type { AppLocale } from "@/i18n/messages";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { auth } from "@/lib/auth";
import { formatBasisPoints, formatMoneyMinor, formatPercentDelta } from "@/lib/format";
import { loadDashboard, loadSpecialistOptions } from "@/lib/dashboard";
import { isCalendarDay, sumExpensesMinor } from "@/lib/expenses";
import { resolveLocale } from "@/lib/locale";
import { getActiveMembership } from "@/lib/membership";
import { monthOf } from "@/lib/period";
import { loadFirstRun, loadMonthSetup, loadOnboarding } from "@/lib/onboarding";

/**
 * A period card for the reports page's top row. The formula still exists —
 * DSH-009 asks for one on every figure — but as a `title` tooltip rather than
 * visible text, since a period-over-period delta takes that line's place
 * whenever a comparable prior period exists (see `formatPercentDelta`).
 */
function MetricCard({
  icon,
  label,
  value,
  formula,
  delta,
  deltaCaption,
  negative,
}: {
  icon: "revenue" | "expenses" | "profit";
  label: string;
  value: string;
  formula: string;
  delta: { text: string; direction: "up" | "down" } | null;
  deltaCaption: string;
  negative?: boolean;
}) {
  return (
    <div className="metric-card" title={formula}>
      <span className="metric-card-icon">
        <MetricIcon name={icon} />
      </span>
      <span className="metric-card-label">{label}</span>
      <strong className={`metric-card-value${negative ? " metric-negative" : ""}`}>{value}</strong>
      {delta && (
        <span className={`metric-delta ${delta.direction === "down" ? "negative" : "positive"}`}>
          {delta.text} {deltaCaption}
        </span>
      )}
    </div>
  );
}

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; specialist?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  /*
   * The one page that resolves its own membership rather than going through
   * `requireWorkspace`, because it owns the two states that have no workspace
   * to require: an account with no organization yet, and a pilot account not
   * enrolled. Both are answered below with a full-page card.
   *
   * The identity it resolves by must still be the effective one. An owner
   * looking at a colleague's interface gets the colleague's navigation from the
   * shell, and a dashboard that quietly answered with the owner's own figures
   * underneath it would be worse than showing nothing: the owner would read
   * their studio's revenue believing it was one master's. `getActiveMembership`
   * is the memoized resolution the shell already made, so this costs nothing
   * and cannot disagree with it.
   */
  const caller = await getActiveMembership();
  const effectiveUserId = caller.session ? (caller.membership?.userId ?? caller.userId) : session.user.id;

  const [membership] = await db
    .select({
      organization: organizations,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, effectiveUserId))
    .limit(1);

  if (!membership) {
    // No organization yet, so its language does not exist to ask: the browser's
    // preference is the only signal, and it becomes the new workspace's locale.
    return <WorkspaceSetup email={session.user.email} locale={await resolveLocale()} />;
  }

  const locale = membership.organization.locale as AppLocale;
  // Wording only: `organization.type` reaches no figure on this page.
  const businessType = membership.organization.type as BusinessType;
  const t = getTranslator(locale);

  const pilotStatus =
    isPilotAccessEnforced()
      ? await withTenant(membership.organization.id, async (tx) => {
          const [enrollment] = await tx
            .select({ status: pilotEnrollments.status })
            .from(pilotEnrollments)
            .limit(1);
          return enrollment?.status ?? null;
        })
      : null;

  if (isPilotAccessEnforced() && pilotStatus !== "active") {
    return (
      <main className="auth-shell">
        <section className="auth-card workspace-card" aria-labelledby="pilot-access-title">
          <span className="brand">Nail Profit OS</span>
          <h1 id="pilot-access-title">{t("pilot.accessTitle")}</h1>
          <p>{t("pilot.accessBody")}</p>
        </section>
      </main>
    );
  }

  if (!can(membership.role, "dashboard", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("dashboard.noAccess")}</p>
      </main>
    );
  }

  const filters = await searchParams;

  /*
   * The first run, which replaces this page rather than being drawn on top of
   * it: a studio with no closed visit has no revenue, no margin and no profit
   * per hour, and every card below would be a zero with a checklist pinned
   * above it.
   *
   * Placed before `loadDashboard` on purpose. Those queries would compute a
   * screenful of zeroes at full price; `loadFirstRun` is one `count` for a
   * studio that has long since started, and answers null for it.
   *
   * Only for a role that can advance a step — all three are catalogue work, so
   * for a master this would be a door they cannot open, and they get the
   * dashboard as before.
   */
  if (canManageCatalogue(membership.role, "services")) {
    const firstRun = await withTenant(membership.organization.id, (tx) => loadFirstRun(tx));
    if (firstRun?.next) {
      return <FirstRun progress={firstRun} next={firstRun.next} locale={locale} />;
    }
  }

  /*
   * The period, taken from the query string and checked before anything reads
   * it. `<input type="date">` sends a real day, but the URL is editable by
   * hand, and «вчера» reached `new Date` as an Invalid Date while the very same
   * string was quietly ignored by the expense ledger — one address, two
   * behaviours. Ignored here too, so an unusable filter simply is not one.
   */
  const from = isCalendarDay(filters.from) ? filters.from : undefined;
  const to = isCalendarDay(filters.to) ? filters.to : undefined;
  const organizationId = membership.organization.id;
  const currency = membership.organization.currency;
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);

  // The period cards compare against the equal-length window immediately
  // before the selected one — only defined when a specific period was picked;
  // "all time" has no prior period to be a delta against.
  const previousRange =
    from && to
      ? (() => {
          const currentFrom = new Date(`${from}T00:00:00.000Z`);
          const currentTo = new Date(`${to}T23:59:59.999Z`);
          const spanMs = currentTo.getTime() - currentFrom.getTime() + 1;
          const previousTo = new Date(currentFrom.getTime() - 1);
          const previousFrom = new Date(previousTo.getTime() - spanMs + 1);
          return { from: previousFrom, to: previousTo };
        })()
      : null;

  /*
   * The ledger is the whole organization's, and the report can be narrowed to
   * one master. Narrowed, neither figure it feeds means anything: the revenue
   * would be that person's while the expenses stayed everyone's — rent is not
   * split per specialist, and the ledger holds nothing that could split it.
   * Both cards drop out together, and the sum is not even asked for.
   */
  const oneSpecialist = Boolean(filters.specialist);

  const data = await withTenant(organizationId, async (tx) => {
    // Section 6.1: a Master sees "только собственные" — resolved from the
    // specialist row carrying their user id, not from the query string.
    let effectiveSpecialist = filters.specialist ?? null;
    if (scopeFor(membership.role, "dashboard") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, session.user.id))
        .limit(1);
      effectiveSpecialist = own?.id ?? "00000000-0000-0000-0000-000000000000";
    }

    const dashboard = await loadDashboard(
      tx,
      {
        from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
        to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
        specialistId: effectiveSpecialist,
      },
      locale,
    );

    const previousMetrics = previousRange
      ? (
          await loadDashboard(
            tx,
            { from: previousRange.from, to: previousRange.to, specialistId: effectiveSpecialist },
            locale,
          )
        ).metrics
      : null;

    /*
     * The expense ledger over the same period.
     *
     * Owner-only, and not merely on the screen: the `expenses` capability
     * denies every other role even the read, so the query does not run for
     * them. Hiding the card while still fetching the number would put rent and
     * payroll in a manager's page payload.
     *
     * The period is the same one the cards use, matched on the day of the
     * purchase (`spent_on`) rather than on when the row was written — the
     * report answers for the month the money left, like the ledger page does.
     */
    const canSeeExpenses = can(membership.role, "expenses", "read") && !oneSpecialist;
    const expenseTotal = canSeeExpenses ? await sumExpensesMinor(tx, { from, to }, currency) : null;
    const previousExpenseTotal =
      canSeeExpenses && previousRange
        ? await sumExpensesMinor(
            tx,
            {
              from: previousRange.from.toISOString().slice(0, 10),
              to: previousRange.to.toISOString().slice(0, 10),
            },
            currency,
          )
        : null;

    const people = await loadSpecialistOptions(tx);
    /*
     * «Первый расчёт» is a setup checklist, and all three of its steps are
     * catalogue work: a specialist with a commission rule, a priced service, a
     * first closed visit. A role that cannot write the shared catalogue cannot
     * advance any of them, so for a master the panel is three links to pages
     * they do not have — a permanent, unfinishable list on the one screen they
     * open every morning.
     *
     * Not computed rather than not rendered: the progress costs several
     * queries, and nobody should pay for them to produce something the page
     * then drops.
     */
    const onboarding = canManageCatalogue(membership.role, "services")
      ? await loadOnboarding(tx)
      : null;

    /*
     * The second checklist, and the two conditions it waits for.
     *
     * It waits for the first one to finish, because a studio with no closed
     * visit has no month to correct — showing both at once would turn a path of
     * three steps into a chore of five, which is the shape «Первый расчёт» was
     * cut down from.
     *
     * And it is the owner's alone: «Затраты» is owner-only by the `expenses`
     * capability, so for a manager both steps would be a list of doors that do
     * not open.
     */
    const monthSetup =
      onboarding?.complete && membership.role === "owner"
        ? await loadMonthSetup(tx, { month: monthOf(new Date()), currency })
        : null;

    return {
      ...dashboard,
      previousMetrics,
      onboarding,
      monthSetup,
      people,
      canFilterBySpecialist: scopeFor(membership.role, "dashboard") === "all",
      expenseTotal,
      previousExpenseTotal,
    };
  });

  const isMaster = membership.role === "master";
  const { metrics, previousMetrics } = data;

  /*
   * «Затраты» is what the ledger totals over the chosen period, and that is all
   * it claims to be.
   *
   * There used to be a «Прибыль» card here reading «выручка − затраты», and it
   * was wrong in both directions at once. If the owner recorded the gel and the
   * wages, it subtracted them a second time — the charts below already take
   * both out of every visit. If the owner recorded neither, it reported the
   * whole margin as profit. Meanwhile «Прибыль по услугам», two panels down,
   * meant the contribution margin: one screen, one word, two answers.
   *
   * The real figure needs a whole month — rent does not divide into the eleven
   * days someone picked in the filter — so it lives in `/app/reports/month`,
   * where recurring costs resolve and the two halves of the ledger are told
   * apart. The link below is the whole of the fix on this page.
   *
   * The card is still null whenever the ledger was not read: for a role that
   * may not see it, or for a report narrowed to one master, where the revenue
   * would be that person's while the rent stayed everyone's.
   */
  const expensesMinor = data.expenseTotal === null ? null : data.expenseTotal.minor;
  const previousExpensesMinor = data.previousExpenseTotal?.minor ?? null;

  const revenueDelta = previousMetrics
    ? formatPercentDelta(metrics.revenueMinor, previousMetrics.revenueMinor, localeCode)
    : null;
  const expensesDelta =
    expensesMinor !== null && previousExpensesMinor !== null
      ? formatPercentDelta(expensesMinor, previousExpensesMinor, localeCode)
      : null;

  // «Прибыль по услугам»: the top of the same ranking the full table below
  // shows, with everything past it folded into one «Прочее» bar so five bars
  // stay readable regardless of how many services the catalogue has.
  const TOP_SERVICES_SHOWN = 4;
  const topServices = metrics.ranking.slice(0, TOP_SERVICES_SHOWN);
  const otherServices = metrics.ranking.slice(TOP_SERVICES_SHOWN);
  const profitByServiceEntries = [
    ...topServices.map((entry) => ({
      key: entry.serviceId ?? entry.serviceName,
      label: entry.serviceName,
      valueMinor: entry.contributionMarginMinor,
    })),
    ...(otherServices.length > 0
      ? [
          {
            key: "__other__",
            label: t("dashboard.otherServices"),
            valueMinor: otherServices.reduce((total, entry) => total + entry.contributionMarginMinor, 0),
          },
        ]
      : []),
  ];

  // «Диаграмма прибыли»: bucketed by `buildProfitTrend` (day or month, decided
  // from the actual spread of the data), labelled here since that is where
  // the viewer's locale lives.
  const profitTrend = buildProfitTrend(data.rows);
  const trendLabelFormat = new Intl.DateTimeFormat(
    localeCode,
    profitTrend.granularity === "day" ? { day: "numeric", month: "short" } : { month: "short", year: "numeric" },
  );
  const profitTrendPoints = profitTrend.points.map((point) => ({
    label: trendLabelFormat.format(
      new Date(profitTrend.granularity === "day" ? `${point.key}T00:00:00Z` : `${point.key}-01T00:00:00Z`),
    ),
    valueMinor: point.profitMinor,
  }));

  const rankingTotals = {
    visits: metrics.ranking.reduce((s, e) => s + e.visits, 0),
    revenueMinor: metrics.ranking.reduce((s, e) => s + e.revenueMinor, 0),
    contributionMarginMinor: metrics.ranking.reduce((s, e) => s + e.contributionMarginMinor, 0),
    commissionMinor: metrics.ranking.reduce((s, e) => s + e.commissionMinor, 0),
  };
  const period =
    from || to
      ? `${from ?? t("filters.periodStart")} — ${to ?? t("filters.periodToday")}`
      : t("filters.allTime");

  return (
    <main className="app-shell">
      <span className="eyebrow report-period">
        {t("dashboard.eyebrow")} · {period}
      </span>

      <details className="calendar-filters report-filters">
        <summary>
          <ToolIcon name="filter" />
          {t("filters.title")}
        </summary>
        <PeriodFilter
          locale={locale}
          from={filters.from}
          to={filters.to}
          specialistId={filters.specialist}
          people={data.people}
          showSpecialist={data.canFilterBySpecialist}
        />
      </details>

      {/*
        Diagnosis now, not onboarding. A studio still on its way to the first
        visit never reaches this page — it gets `FirstRun` above — so what is
        left here is the studio that has been trading for a year and has just
        had a ○ come back: a commission rule that ended, the last service a
        rule covered archived. Those close visits with MISSING_COMMISSION_RULE
        and have nowhere else to be told why.
      */}
      {data.onboarding && !data.onboarding.complete && (
        <OnboardingPanel progress={data.onboarding} locale={locale} />
      )}

      {data.monthSetup && !data.monthSetup.complete && (
        <MonthSetupPanel progress={data.monthSetup} locale={locale} />
      )}

      {metrics.incompleteVisits > 0 && (
        <div className="warning-banner">
          <strong>
            {t("dashboard.incompleteTitle", {
              incomplete: metrics.incompleteVisits,
              total: metrics.visits,
            })}
          </strong>{" "}
          {t("dashboard.incompleteBody", { revenue: money(metrics.incompleteRevenueMinor) })}
          <ul>
            {Object.entries(metrics.incompleteReasonCounts).map(([reason, count]) => (
              <li key={reason}>
                {t(`reason.${reason}` as MessageKey)}: {count}
              </li>
            ))}
          </ul>
          <Link className="text-link" href="/app/visits">
            {t("dashboard.openVisits")}
          </Link>
        </div>
      )}

      {!isMaster && (
        <section className="panel insight-panel">
          <h2>{t("dashboard.periodTotals")}</h2>
          <div className="metric-cards">
            <MetricCard
              icon="revenue"
              label={t("dashboard.revenue")}
              value={money(metrics.revenueMinor)}
              formula={t("dashboard.revenueFormula", { visits: metrics.visits })}
              delta={revenueDelta}
              deltaCaption={t("dashboard.vsPreviousPeriod")}
            />
            {expensesMinor !== null && (
              <MetricCard
                icon="expenses"
                label={t("dashboard.expenses")}
                value={money(expensesMinor)}
                formula={t("dashboard.expensesFormula")}
                delta={expensesDelta}
                deltaCaption={t("dashboard.vsPreviousPeriod")}
              />
            )}
          </div>
          {/*
            Where the profit went, said plainly. A figure that quietly
            disappears from a screen someone reads every morning is worse
            than the wrong figure it replaced.
          */}
          {expensesMinor !== null && (
            <p className="muted">
              {t("dashboard.profitMoved")}{" "}
              <Link className="text-link" href="/app/reports/month">
                {t("nav.monthReport")}
              </Link>
            </p>
          )}
          {/*
            Said out loud rather than folded in. The currency of the
            organization can be changed and nothing already recorded is
            converted, so a ledger can hold both — and a card that quietly
            dropped the other rows would be a smaller number with no
            explanation.
          */}
          {(data.expenseTotal?.excludedRows ?? 0) > 0 && (
            <p className="muted">
              {t("dashboard.expensesOtherCurrency", { count: data.expenseTotal!.excludedRows })}
            </p>
          )}
        </section>
      )}

      {!isMaster && profitByServiceEntries.length > 0 && (
        <div className="report-charts-grid">
          <section className="panel">
            <h2>{t("dashboard.profitByService")}</h2>
            <ProfitBars entries={profitByServiceEntries} formatMoney={money} />
          </section>
          <section className="panel">
            <h2>{t("dashboard.profitTrend")}</h2>
            <ProfitTrendChart
              points={profitTrendPoints}
              formatMoney={money}
              emptyLabel={t("dashboard.profitTrendEmpty")}
              title={t("dashboard.profitTrend")}
            />
          </section>
        </div>
      )}

      <section className="panel">
        <h2>{t("dashboard.rankingTitle")}</h2>
        <p className="muted">{t("dashboard.rankingHint")}</p>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("dashboard.service")}</th>
              <th>{t("dashboard.visitCount")}</th>
              {!isMaster && <th>{t("dashboard.revenue")}</th>}
              {!isMaster && <th>{t(businessLabel.masterEarnings[businessType])}</th>}
              <th>{isMaster ? t("dashboard.commission") : t("dashboard.keeps")}</th>
              {!isMaster && <th>{t("dashboard.margin")}</th>}
              <th>{t("dashboard.hourly")}</th>
            </tr>
          </thead>
          <tbody>
            {metrics.ranking.map((entry) => (
              <tr key={entry.serviceId ?? entry.serviceName}>
                <td>{entry.serviceName}</td>
                <td>{entry.visits}</td>
                {!isMaster && <td>{money(entry.revenueMinor)}</td>}
                {!isMaster && <td>{money(entry.commissionMinor)}</td>}
                {isMaster ? (
                  <td>{money(entry.commissionMinor)}</td>
                ) : (
                  <td className={entry.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                    {money(entry.contributionMarginMinor)}
                  </td>
                )}
                {!isMaster && <td>{formatBasisPoints(entry.marginBasisPoints, localeTag(locale))}</td>}
                <td className={(entry.profitPerHourMinor ?? 0) < 0 ? "metric-negative" : ""}>
                  {entry.profitPerHourMinor === null ? "—" : money(entry.profitPerHourMinor)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{t("visits.total")}</th>
              <td>{rankingTotals.visits}</td>
              {!isMaster && <td>{money(rankingTotals.revenueMinor)}</td>}
              {!isMaster && <td>{money(rankingTotals.commissionMinor)}</td>}
              {isMaster ? (
                <td>{money(rankingTotals.commissionMinor)}</td>
              ) : (
                <td className={rankingTotals.contributionMarginMinor < 0 ? "metric-negative" : ""}>
                  {money(rankingTotals.contributionMarginMinor)}
                </td>
              )}
              {!isMaster && <td />}
              <td />
            </tr>
          </tfoot>
        </table>
      </section>
    </main>
  );
}
