import Link from "next/link";

import type { ChecklistProgress } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * The path to a first number, roadmap phase 4 "onboarding progress".
 *
 * Every step is linked, not just the next one — an owner who already knows the
 * piece they are missing should not be walked through a wizard to reach it. The
 * list is a map of what is missing, not a gate.
 *
 * What the map was missing is where to put a foot next. The first unfinished
 * step is singled out by a moving arrow and nothing else: every step keeps the
 * same one link, so there is never a second control to the same page and never
 * a paragraph of advice between two lines of a list.
 *
 * A server component: nothing here reacts to anything, so the dashboard pays
 * for no JavaScript bundle to render it.
 */
function ChecklistPanel<Key extends string>({
  progress,
  locale,
  prefix,
}: {
  progress: ChecklistProgress<Key>;
  locale: AppLocale;
  /** Which family of strings names the steps: `<prefix>.<step key>`. */
  prefix: "onboarding" | "monthSetup";
}) {
  const t = getTranslator(locale);
  const label = (step: string) => t(`${prefix}.${step}` as MessageKey);

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
}: {
  progress: ChecklistProgress<"specialist" | "service" | "visit">;
  locale: AppLocale;
}) {
  return <ChecklistPanel progress={progress} locale={locale} prefix="onboarding" />;
}

/**
 * The month's own checklist, shown only once the first one is finished.
 *
 * Same panel deliberately: it is the same promise — every ○ is a figure the
 * report cannot state yet — and a second design for it would suggest otherwise.
 */
export function MonthSetupPanel({
  progress,
  locale,
}: {
  progress: ChecklistProgress<"overhead" | "rota">;
  locale: AppLocale;
}) {
  return <ChecklistPanel progress={progress} locale={locale} prefix="monthSetup" />;
}
