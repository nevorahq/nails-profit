import { and, count, eq, exists, gt, isNotNull, isNull, lte, notExists, or, sql } from "drizzle-orm";

import {
  commissionRuleServices,
  commissionRules,
  expenses,
  services,
  specialists,
  visits,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { expensesForMonth } from "@/domain/expense-periods";
import { loadMonthRota } from "@/lib/capacity";

/**
 * The two checklists a studio is walked through, and the shape they share.
 *
 * A step is measured rather than ticked off, and it measures the *usable*
 * thing, not the row: a service with no price does not count as a service, and
 * a rule that ended is not a rule. Nothing here is stored, so nothing can claim
 * a studio is set up after the data that set it up was archived.
 */
export type ChecklistStep<Key extends string> = Readonly<{
  key: Key;
  done: boolean;
  href: string;
}>;

export type ChecklistProgress<Key extends string> = Readonly<{
  steps: readonly ChecklistStep<Key>[];
  done: number;
  total: number;
  complete: boolean;
  /** The first unfinished step — what the interface should point at. */
  next: ChecklistStep<Key> | null;
}>;

export type OnboardingStep = ChecklistStep<"specialist" | "service">;
export type OnboardingProgress = ChecklistProgress<"specialist" | "service">;

/**
 * The second checklist, and the reason there are two.
 *
 * Everything above answers «сколько я заработал на визите», and it is answered
 * by the visit alone. The month is a different question — «сколько осталось
 * после аренды» — and it needs two facts the visit never carries: what the
 * studio pays whether or not anyone comes, and how many hours were open. A
 * studio with neither still gets a report, and every figure in it reads better
 * than the truth: operating profit equal to contribution margin, and no
 * break-even to compare it with.
 *
 * Kept out of `loadOnboarding` rather than added to it as steps four and five,
 * because a checklist that goes on growing after the first number arrives stops
 * being a path and becomes a chore. This one only appears once the first one is
 * finished.
 */
export type MonthSetupStep = ChecklistStep<"overhead" | "rota">;
export type MonthSetupProgress = ChecklistProgress<"overhead" | "rota">;

function summarize<Key extends string>(steps: readonly ChecklistStep<Key>[]): ChecklistProgress<Key> {
  const done = steps.filter((step) => step.done).length;
  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    next: steps.find((step) => !step.done) ?? null,
  };
}

/**
 * Onboarding progress.
 *
 * Each step is the thing that has to be true before the next one can produce a
 * number, which is why the order is fixed and why a step is measured rather
 * than ticked off: a specialist without a commission rule leaves the costing
 * engine unable to answer — and the owner staring at "не хватает данных" with
 * no idea which piece is missing.
 *
 * The steps therefore check for the *usable* thing, not the row. A service with
 * no price does not count as a service here.
 *
 * Two steps, and both of them are settings. Materials with a purchase price and
 * a recipe per service used to sit at positions two and four, and between them
 * they were most of the work before a studio saw its first number; they went
 * with the material engine.
 *
 * «Закройте первый визит» went later and for a different reason. It was not a
 * setting at all — a visit is something that happens, and a checklist that asks
 * for one is asking the studio to invent a client to earn a tick. It was here
 * because it used to be the only way to a number: nothing in the product said
 * anything until a visit had been closed. That stopped being true when the
 * setup screen started collecting a rate and priced services, because
 * `lib/service-costing.ts` answers from those alone — margin, and profit per
 * hour, per service, before anybody has walked in. So the first number arrives
 * on its own and the visit is left to be what it is: the studio's work, not its
 * homework.
 */
export async function loadOnboarding(tx: TenantTransaction): Promise<OnboardingProgress> {
  const now = new Date();

  /*
   * A rule a visit could actually be paid by today, which takes three things.
   *
   * The window is the one `selectCommissionRule` applies — open at
   * `active_from`, closed at `active_to`. An ended rule is history: the
   * specialist costs as «нет правила комиссии» again, and the step has to say
   * so rather than remember that a rule was once written.
   *
   * The other two are the rule's restrictions, and both die with the catalogue
   * because deleting a service archives it rather than removing the row. A rule
   * with `service_id` is an exception for that one service; a rule with rows in
   * `commission_rule_service` pays only on those services, while no rows at all
   * means every service — that is what rules written before the table existed
   * do. Either way, once every service it names is archived, the rule pays for
   * nothing.
   *
   * What is deliberately *not* required is that the studio have any services at
   * all: an unrestricted rule is complete on its own, and this step comes before
   * the catalogue in the list.
   */
  const ruleTargetsLiveService = or(
    isNull(commissionRules.serviceId),
    exists(
      tx
        .select({ one: sql`1` })
        .from(services)
        .where(
          and(sql`${services.id} = ${commissionRules.serviceId}`, isNull(services.archivedAt)),
        ),
    ),
  );

  const ruleCoversLiveService = or(
    notExists(
      tx
        .select({ one: sql`1` })
        .from(commissionRuleServices)
        .where(eq(commissionRuleServices.commissionRuleId, commissionRules.id)),
    ),
    exists(
      tx
        .select({ one: sql`1` })
        .from(commissionRuleServices)
        .innerJoin(services, eq(services.id, commissionRuleServices.serviceId))
        .where(
          and(
            eq(commissionRuleServices.commissionRuleId, commissionRules.id),
            isNull(services.archivedAt),
          ),
        ),
    ),
  );

  const [withRule] = await tx
    .select({ value: count() })
    .from(specialists)
    .innerJoin(
      commissionRules,
      and(
        eq(commissionRules.specialistId, specialists.id),
        lte(commissionRules.activeFrom, now),
        or(isNull(commissionRules.activeTo), gt(commissionRules.activeTo, now)),
        ruleTargetsLiveService,
        ruleCoversLiveService,
      ),
    )
    .where(isNull(specialists.archivedAt));

  const [usableServices] = await tx
    .select({ value: count() })
    .from(services)
    .where(
      and(
        isNull(services.archivedAt),
        isNotNull(services.priceMinor),
        isNotNull(services.durationMinutes),
      ),
    );

  /*
   * Where this step is actually finished, which is not one address.
   *
   * The rule can be written in two places — the add-specialist form on
   * `/app/specialists`, and the card of somebody who already exists. Which one
   * to send a studio to depends on whether there is anybody to write a rule
   * for, and a solo workspace now always has somebody: the owner's card is
   * created with the organization, so `#add-specialist` would open a form for
   * hiring a second person when the only thing missing is a rate for the
   * first.
   *
   * Exactly one, or the bare form. With two masters and no rules there is no
   * card that is the obvious one, and a guess would send the owner to the
   * wrong colleague.
   *
   * Neither is `/app/settings`, which is where this pointed for as long as the
   * panel existed: Настройки hold the organization, the subscription and the
   * team, and offer no way to finish this step at all.
   */
  let specialistHref = "/app/specialists#add-specialist";
  if (withRule.value === 0) {
    const waiting = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .limit(2);
    if (waiting.length === 1) specialistHref = `/app/specialists/${waiting[0].id}`;
  }

  const steps: OnboardingStep[] = [
    { key: "specialist", done: withRule.value > 0, href: specialistHref },
    { key: "service", done: usableServices.value > 0, href: "/app/services#add-service" },
  ];

  return summarize(steps);
}

/**
 * Whether a screen should be running the guided setup, and from what standing.
 *
 * `loadFirstRun` is the same question with the whole checklist as its answer —
 * what the dashboard needs to name the one thing to do next — and
 * `loadSetupGuide` is the counter the guided window compares against. One
 * `count` answers the common case, so a studio that has long since started
 * pays for a single row and nothing else.
 *
 * Two gates, and they refuse for different reasons.
 *
 * A studio that has closed a visit is trading, and nothing puts it back into a
 * guided first run — not a commission rule that expired, not the last service a
 * rule covered being archived. Those put a ○ back on the dashboard's diagnosis
 * panel, which is that panel's whole job.
 *
 * A studio with nothing left on the checklist is not on a first run either, and
 * that case is new: the setup screen now writes the rate and the priced
 * services itself, so an owner can arrive here finished before a single client
 * has been seen. Sending them to a goal panel with no goal — or worse, to one
 * invented to fill it — would undo exactly what that screen was for.
 */
export async function loadFirstRun(tx: TenantTransaction): Promise<OnboardingProgress | null> {
  const [closedVisits] = await tx.select({ value: count() }).from(visits);
  if (closedVisits.value > 0) return null;

  const progress = await loadOnboarding(tx);
  return progress.complete ? null : progress;
}

export async function loadSetupGuide(
  tx: TenantTransaction,
): Promise<{ done: number; total: number } | null> {
  const progress = await loadFirstRun(tx);
  return progress && { done: progress.done, total: progress.total };
}

/**
 * Whether the expense and rota screens should be running the month's guided
 * setup, and from what standing — `loadSetupGuide` for the second checklist.
 *
 * Two silences, and they are different. Before the first closed visit there is
 * no month to correct: that studio is still on «Первый расчёт», and a second
 * guide running underneath the first one would be two windows arguing over the
 * same person. After both steps are done the guide is over for good — the
 * ledger is used every week, and an owner recording March's electricity does
 * not want a congratulation window for it.
 *
 * Measured for the month asked about, like everything else here, so a studio
 * that filled January in and stopped is guided again in March.
 */
export async function loadMonthGuide(
  tx: TenantTransaction,
  options: { month: string; currency: string },
): Promise<{ done: number; total: number } | null> {
  const [closedVisits] = await tx.select({ value: count() }).from(visits);
  if (closedVisits.value === 0) return null;

  const progress = await loadMonthSetup(tx, options);
  return progress.complete ? null : { done: progress.done, total: progress.total };
}

/**
 * What the month's report is still missing, measured the same way.
 *
 * Both steps are read for the month being reported rather than for all time: a
 * studio that entered its rent in January and stopped is not set up for March,
 * and a checklist that remembered January would say it was.
 */
export async function loadMonthSetup(
  tx: TenantTransaction,
  options: { month: string; currency: string },
): Promise<MonthSetupProgress> {
  /*
   * The live ledger, not the month's rows — a recurring row is stored once with
   * an interval, and the row that pays March's rent may carry a January
   * `spent_on`. `expensesForMonth` is what decides what belongs, exactly as
   * `loadPeriodPL` does; filtering by date in SQL would drop the rows the month
   * is built on.
   *
   * Narrowed to overhead, because those are the only ones the profit line
   * subtracts: a payroll row is money leaving the account, but the master's
   * work already reached the report through the visit's snapshot.
   */
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

  const thisMonth = expensesForMonth(
    ledger.filter((row) => row.currency === options.currency),
    options.month,
  );
  const hasOverhead = thisMonth.some((row) => row.class === "overhead");

  // The same rota the capacity block reads, so the step cannot claim hours the
  // report does not see.
  const { scheduledMinutes } = await loadMonthRota(tx, options.month);

  return summarize<"overhead" | "rota">([
    { key: "overhead", done: hasOverhead, href: "/app/expenses" },
    { key: "rota", done: scheduledMinutes > 0, href: "/app/booking" },
  ]);
}
