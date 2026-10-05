import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CloseDayPanel } from "@/components/close-day-panel";
import { FirstNumbers } from "@/components/first-numbers";
import { FirstRun } from "@/components/first-run";
import { HeadlineCard } from "@/components/headline-card";
import { MetricIcon } from "@/components/icons";
import { MonthSetupPanel, OnboardingPanel } from "@/components/onboarding-panel";
import { PeriodFilter } from "@/components/period-filter";
import { ProfitTrendChart } from "@/components/profit-trend-chart";
import { ReportTabs } from "@/components/report-tabs";
import { ServiceRankingCompact } from "@/components/service-ranking-compact";
import { WorkspaceSetup } from "@/components/workspace-setup";
import { db } from "@/db";
import { memberships, organizations, pilotEnrollments, specialists } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { buildProfitTrend } from "@/domain/dashboard-metrics";
import { can, canManageCatalogue, scopeFor, seesIndividualPay } from "@/domain/rbac";
import { isPilotAccessEnforced, isPublicBookingEnabled } from "@/env";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { queryFor } from "@/lib/filter-bar";
import { auth } from "@/lib/auth";
import { formatMoneyMinor, formatPercentDelta } from "@/lib/format";
import { loadDashboard, loadSpecialistOptions } from "@/lib/dashboard";
import { loadHeadline } from "@/lib/headline";
import { isCalendarDay, sumExpensesMinor } from "@/lib/expenses";
import { resolveLocale } from "@/lib/locale";
import { getActiveMembership } from "@/lib/membership";
import { monthOf } from "@/lib/period";
import { presetRanges, previousRangeOf, resolveReportPeriod, todayIn } from "@/domain/report-period";
import { formatLocalDate } from "@/domain/timezone";
import { loadStartScreen } from "@/lib/first-numbers";
import { loadMonthSetup, loadOnboarding } from "@/lib/onboarding";
import { loadUnclosedBookings } from "@/lib/unclosed-bookings";

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
    return (
      <WorkspaceSetup locale={await resolveLocale()} bookingAvailable={isPublicBookingEnabled()} />
    );
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
   * Appointments that happened and were never closed into a visit — money no
   * report has seen. Asked before the start screen is chosen, because a studio
   * whose only work so far is unclosed bookings is still on that screen. Read
   * as the person being viewed, so a preview shows their own list.
   */
  const unclosed = can(membership.role, "bookings", "write")
    ? await withTenant(membership.organization.id, (tx) =>
        loadUnclosedBookings(
          tx,
          { userId: effectiveUserId, role: membership.role },
          { now: new Date(), locale, limit: 5 },
        ),
      )
    : null;
  const closeDay =
    unclosed && unclosed.count > 0 ? (
      <CloseDayPanel
        items={unclosed.items}
        count={unclosed.count}
        totalMinor={unclosed.totalMinor}
        currency={membership.organization.currency}
        locale={locale}
        showSpecialist={businessType === "studio" && membership.role !== "master"}
      />
    ) : null;

  /*
   * What a studio sees before it has sold anything, which replaces this page
   * rather than being drawn on top of it: with no closed visit there is no
   * revenue, no margin and no profit per hour, and every card below would be a
   * zero.
   *
   * Two answers, decided by `loadStartScreen`. A studio that is still missing a
   * rate or a priced service gets the one goal that would fix it. A studio that
   * has both — which, since the setup screen started collecting them, is most
   * studios on their first day — gets what its catalogue is already worth per
   * service. Neither is a checklist: the first is one step, and the second is
   * the product's own answer, arriving before the first client rather than
   * after a week of typing visits in.
   *
   * Placed before `loadDashboard` on purpose. Those queries would compute a
   * screenful of zeroes at full price; this is one `count` for a studio that
   * has long since started, and answers null for it.
   *
   * Only for a role that can advance a step — both steps are catalogue work, so
   * for a master this would be a door they cannot open, and they get the
   * dashboard as before.
   */
  /*
   * A studio that has not yet confirmed the prices and week it opens with is
   * asked that before anything else — before the numbers, because the numbers
   * are computed from those prices. The owner's question alone: the endpoint
   * that answers it is theirs, and a master opening the app meanwhile gets the
   * dashboard as always.
   */
  if (membership.organization.setupConfirmedAt === null && can(membership.role, "organization_settings", "write")) {
    redirect("/app/setup");
  }

  if (canManageCatalogue(membership.role, "services")) {
    const start = await withTenant(membership.organization.id, (tx) => loadStartScreen(tx, locale, membership.organization.id));
    if (start?.kind === "goal" && start.progress.next) {
      return (
        <FirstRun
          progress={start.progress}
          next={start.progress.next}
          locale={locale}
          businessType={businessType}
        />
      );
    }
    if (start?.kind === "numbers") {
      return (
        <FirstNumbers
          rows={start.rows}
          locale={locale}
          businessType={businessType}
          currency={membership.organization.currency}
          closeDay={closeDay}
          /*
           * Three conditions have to hold before an address can be handed to
           * clients, and they live in three places: the deployment's own flag,
           * the organization's rung on the rollout ladder, and the address's
           * own settings. Any one of them saying no makes `/book/<slug>` a 404,
           * and a link to that is worse than no link.
           */
          bookingSlug={
            isPublicBookingEnabled() &&
            membership.organization.bookingAccess === "public" &&
            start.bookingPublished
              ? membership.organization.slug
              : null
          }
          bookingClosed={
            isPublicBookingEnabled() &&
            membership.organization.bookingAccess !== "off" &&
            !(membership.organization.bookingAccess === "public" && start.bookingPublished)
          }
        />
      );
    }
  }

  /*
   * The period, taken from the query string and checked before anything reads
   * it. `<input type="date">` sends a real day, but the URL is editable by
   * hand, and «вчера» reached `new Date` as an Invalid Date while the very same
   * string was quietly ignored by the expense ledger — one address, two
   * behaviours. Ignored here too, so an unusable filter simply is not one.
   *
   * Nothing usable means the month the studio is in, by its own clock — see
   * `domain/report-period.ts` for why only the choice of month is local.
   */
  const today = todayIn(new Date(), membership.organization.timezone);
  const period = resolveReportPeriod(
    {
      from: isCalendarDay(filters.from) ? filters.from : undefined,
      to: isCalendarDay(filters.to) ? filters.to : undefined,
    },
    today,
  );
  const { from, to } = period;
  const organizationId = membership.organization.id;
  const currency = membership.organization.currency;
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);

  /*
   * The card follows the filter when the filter is a month, and stays on the
   * current month otherwise: a year or a span of days has no rent of its own
   * to subtract, and half a month of rent is a number nobody agreed on.
   */
  const currentMonth = formatLocalDate(today).slice(0, 7);
  const headlineMonth = period.month ?? currentMonth;

  const previousDays = previousRangeOf(period);
  const previousRange = previousDays
    ? {
        from: new Date(`${previousDays.from}T00:00:00.000Z`),
        to: new Date(`${previousDays.to}T23:59:59.999Z`),
      }
    : null;

  /*
   * The ledger is the whole organization's, and the report can be narrowed to
   * one master. Narrowed, neither figure it feeds means anything: the revenue
   * would be that person's while the expenses stayed everyone's — rent is not
   * split per specialist, and the ledger holds nothing that could split it.
   * Both cards drop out together, and the sum is not even asked for.
   */
  /*
   * Whose report this may be narrowed to. Reading the whole studio is not
   * the same permission as reading one person out of it: an analyst holds
   * «Все агрегаты», and a filter that leaves one master standing turns the
   * aggregate into that master's month. The scope decides whether the
   * report is the studio's; `seesIndividualPay` decides whether it can be
   * pointed at somebody.
   *
   * Decided before anything is read, and the query string is honoured only
   * when it may be: hiding the picker is not access control, and a typed
   * `?specialist=` used to narrow an analyst's report all the same.
   */
  const canFilterBySpecialist =
    scopeFor(membership.role, "dashboard") === "all" && seesIndividualPay(membership.role);
  const requestedSpecialist = canFilterBySpecialist ? filters.specialist : undefined;

  const oneSpecialist = Boolean(requestedSpecialist);

  const data = await withTenant(organizationId, async (tx) => {
    // Section 6.1: a Master sees "только собственные" — resolved from the
    // specialist row carrying their user id, not from the query string. The
    // effective user's, so an owner previewing a master reads that master's
    // card rather than their own.
    let effectiveSpecialist = requestedSpecialist ?? null;
    let ownSpecialistId: string | null = null;
    if (scopeFor(membership.role, "dashboard") === "own") {
      const [own] = await tx
        .select({ id: specialists.id })
        .from(specialists)
        .where(eq(specialists.userId, effectiveUserId))
        .limit(1);
      ownSpecialistId = own?.id ?? null;
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

    /*
     * The card the page opens with. A month's figure, never the filter's: for
     * the owner it is the monthly report's bottom line, read by the very call
     * that report makes, so the two cannot disagree.
     */
    const headline = await loadHeadline(
      tx,
      { role: membership.role, month: headlineMonth, currency, organizationId, ownSpecialistId },
      locale,
    );

    return {
      ...dashboard,
      headline,
      previousMetrics,
      onboarding,
      monthSetup,
      people,
      canFilterBySpecialist,
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
   * days someone picked in the filter — so it is the card at the top, read
   * from the monthly report itself, and not a third card in this row.
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

  // A month by its name, the way the card above names it; any other span by
  // its two days, an open end said in words.
  const periodLabel = period.month
    ? new Intl.DateTimeFormat(localeCode, { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(`${period.month}-01T00:00:00.000Z`),
      )
    : `${from ?? t("filters.periodStart")} — ${to ?? t("filters.periodToday")}`;

  return (
    <main className="app-shell">
      <ReportTabs
        locale={locale}
        role={membership.role}
        active="summary"
        state={{ from: filters.from, to: filters.to, specialist: requestedSpecialist, month: period.month }}
      />
      <HeadlineCard
        headline={data.headline}
        locale={locale}
        currency={currency}
        month={headlineMonth}
        isCurrentMonth={headlineMonth === currentMonth}
        detailsHref={
          can(membership.role, "expenses", "read")
            ? headlineMonth === currentMonth
              ? "/app/reports/month"
              : `/app/reports/month?month=${headlineMonth}`
            : null
        }
      />
      {closeDay}
      <span className="eyebrow report-period">
        {t("dashboard.eyebrow")} · {periodLabel}
      </span>

      <PeriodFilter
        locale={locale}
        from={from}
        to={to}
        specialistId={requestedSpecialist}
        people={data.people}
        presets={{ ranges: presetRanges(today), active: period.preset }}
        /*
          A picker over one person narrows nothing. The capability is still what
          decides whether the report *may* be narrowed — a master may not — and
          the count decides whether there is anything to narrow to.
        */
        showSpecialist={data.canFilterBySpecialist && data.people.length > 1}
      />

      {/*
        Diagnosis now, not onboarding. A studio still on its way to the first
        visit never reaches this page — it gets `FirstRun` above — so what is
        left here is the studio that has been trading for a year and has just
        had a ○ come back: a commission rule that ended, the last service a
        rule covered archived. Those close visits with MISSING_COMMISSION_RULE
        and have nowhere else to be told why.
      */}
      {data.onboarding && !data.onboarding.complete && (
        <OnboardingPanel
          progress={data.onboarding}
          locale={locale}
          businessType={businessType}
        />
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

      {metrics.ranking.length > 0 && (
        <ServiceRankingCompact
          ranking={metrics.ranking}
          locale={locale}
          currency={currency}
          businessType={businessType}
          isMaster={isMaster}
          allHref={queryFor("/app/reports/services", {
            from: filters.from,
            to: filters.to,
            specialist: requestedSpecialist,
          })}
        />
      )}

      {/* «Прибыль по услугам» as bars lives on «Услуги» now, beside the table it
          draws; the trend over time is the one chart that answers «Итог». */}
      {!isMaster && metrics.ranking.length > 0 && (
        <section className="panel">
          <h2>{t("dashboard.profitTrend")}</h2>
          <ProfitTrendChart
            points={profitTrendPoints}
            formatMoney={money}
            emptyLabel={t("dashboard.profitTrendEmpty")}
            title={t("dashboard.profitTrend")}
          />
        </section>
      )}
    </main>
  );
}
