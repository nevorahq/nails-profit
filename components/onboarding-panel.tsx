import Link from "next/link";

import type { OnboardingProgress } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * The path to a first number, roadmap phase 4 "onboarding progress".
 *
 * Every step is linked, not just the next one — an owner who already knows the
 * piece they are missing should not be walked through a wizard to reach it.
 * The list is a map of what is missing, not a gate.
 *
 * A server component: nothing here reacts to anything, so the dashboard pays
 * for no JavaScript bundle to render it.
 */
export function OnboardingPanel({
  progress,
  locale,
}: {
  progress: OnboardingProgress;
  locale: AppLocale;
}) {
  const t = getTranslator(locale);

  return (
    <section className="panel">
      <h2>{t("onboarding.title")}</h2>
      <p className="muted">{t("onboarding.progress", { done: progress.done, total: progress.total })}</p>

      <ol className="compact-list">
        {progress.steps.map((step) => (
          <li key={step.key} className={step.done ? "muted" : undefined}>
            <span aria-hidden="true">{step.done ? "✓" : "○"}</span>{" "}
            {step.done ? (
              t(`onboarding.${step.key}` as MessageKey)
            ) : (
              <Link className="text-link" href={step.href}>
                {t(`onboarding.${step.key}` as MessageKey)}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
