import Link from "next/link";

import { GoalPanel } from "@/components/goal-panel";
import type { ChecklistProgress } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { stepMessageKey } from "@/i18n/step-labels";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * The path to a first number, roadmap phase 4 "onboarding progress".
 *
 * Every step is linked, not just the next one — an owner who already knows the
 * piece they are missing should not be walked through a wizard to reach it. The
 * list is a map of what is missing, not a gate.
 *
 * What the map was missing is where to put a foot next. The first unfinished
 * step is singled out by a moving arrow and one line saying what it will make
 * the report able to state — the step alone names a thing to enter, not a
 * reason to enter it, and «Услуга с ценой и длительностью» reads as data entry
 * until you know neither margin nor profit per hour exists without both.
 *
 * Only that step carries its line. A hint under every row would turn a list
 * that can be read at a glance into a page of advice.
 *
 * A server component: nothing here reacts to anything, so the dashboard pays
 * for no JavaScript bundle to render it.
 */
function ChecklistPanel<Key extends string>({
  progress,
  locale,
  businessType,
  prefix,
}: {
  progress: ChecklistProgress<Key>;
  locale: AppLocale;
  businessType: BusinessType;
  /**
   * Which family of strings names the steps: `<prefix>.<step key>`. Only the
   * first run is a list — the month asks for one thing at a time and is drawn
   * as a goal below, so it has no checklist strings to name here.
   */
  prefix: "onboarding";
}) {
  const t = getTranslator(locale);
  const label = (step: string) => t(stepMessageKey(`${prefix}.${step}`, businessType));

  return (
    <section className="panel">
      <h2>{t(`${prefix}.title` as MessageKey)}</h2>
      <p className="muted">
        {t(`${prefix}.progress` as MessageKey, { done: progress.done, total: progress.total })}
      </p>

      <ol className="compact-list">
        {progress.steps.map((step) => {
          const isNext = progress.next?.key === step.key;

          return (
            <li key={step.key} className={step.done ? "muted" : undefined}>
              {/*
                The one thing on the panel that moves, and it moves at the step
                to start with. Decoration, not information: the ✓/○/→ is
                `aria-hidden` and the state a reader is told is the link or the
                plain text beside it.
              */}
              <span aria-hidden="true" className={isNext ? "checklist-arrow" : undefined}>{step.done ? "✓" : isNext ? "→" : "○"}</span>{" "}
              {step.done ? (
                label(step.key)
              ) : (
                <Link className="text-link" href={step.href}>
                  {label(step.key)}
                </Link>
              )}
              {isNext && <span className="checklist-hint">{label(`${step.key}Hint`)}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function OnboardingPanel({
  progress,
  locale,
  businessType,
}: {
  progress: ChecklistProgress<"specialist" | "service" | "visit">;
  locale: AppLocale;
  businessType: BusinessType;
}) {
  return (
    <ChecklistPanel
      progress={progress}
      locale={locale}
      businessType={businessType}
      prefix="onboarding"
    />
  );
}

/**
 * The month's own setup, shown only once the first run is finished.
 *
 * Built as one goal rather than as a list, exactly like the first run — the
 * same promise made in a different place. Two ○ under a heading called «Расчёт
 * месяца» read as a second helping of homework arriving the moment the first
 * one was cleared; one goal and its button read as the next move.
 *
 * The goal is now the whole of it. A section name over it, a line of stakes
 * under that and a hint under the goal made three sentences of preamble for
 * one instruction, on a panel whose entire argument is that it asks for one
 * thing.
 *
 * Null when there is nothing left to point at. The dashboard already declines
 * to render a finished checklist, so this is a guard rather than a state
 * anybody reaches.
 */
export function MonthSetupPanel({
  progress,
  locale,
}: {
  progress: ChecklistProgress<"overhead" | "rota">;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const next = progress.next;
  if (!next) return null;

  const index = progress.steps.findIndex((step) => step.key === next.key);
  const previous = index > 0 ? progress.steps[index - 1] : null;

  return (
    <GoalPanel
      goal={t(`step.goal.${next.key}` as MessageKey)}
      action={t(`step.action.${next.key}` as MessageKey)}
      href={next.href}
      remaining={t("step.remaining", { count: progress.total - progress.done })}
      back={
        previous && {
          label: t("step.back", { step: t(`monthSetup.${previous.key}` as MessageKey) }),
          href: previous.href,
        }
      }
    />
  );
}
