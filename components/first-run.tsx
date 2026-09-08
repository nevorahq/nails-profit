import { GoalPanel } from "@/components/goal-panel";
import type { OnboardingProgress, OnboardingStep } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { stepMessageKey } from "@/i18n/step-labels";
import { getTranslator } from "@/i18n/t";

/**
 * What a studio sees on `/app` before it has closed a single visit.
 *
 * It replaces the dashboard rather than sitting above it, and that is the whole
 * point. A studio with no visits has no revenue, no margin and no profit per
 * hour, so the dashboard it used to get was a wall of zeroes with a list of
 * homework pinned above it — the two together read as «этот продукт мне ничего
 * не посчитал и ещё задал работу».
 *
 * A server component: nothing here reacts to anything.
 */
export function FirstRun({
  progress,
  next,
  locale,
  businessType,
}: {
  progress: OnboardingProgress;
  /** The step to point at. Resolved by the caller, so this cannot render goal-less. */
  next: OnboardingStep;
  locale: AppLocale;
  /**
   * Whose first run this is. The first step is written twice — a studio hires
   * a master, somebody working alone prices their own hour — and this is the
   * screen where the difference is loudest, since it is the whole screen.
   */
  businessType: BusinessType;
}) {
  const t = getTranslator(locale);
  /*
   * The step before this one, so «назад» is a step of the run rather than the
   * browser's own button. Null on the first step: behind it is the studio form,
   * which is not somewhere anybody should be sent back to.
   */
  const index = progress.steps.findIndex((step) => step.key === next.key);
  const previous = index > 0 ? progress.steps[index - 1] : null;

  return (
    <main className="app-shell">
      <GoalPanel
        eyebrow={t("firstRun.title")}
        goal={t(stepMessageKey(`step.goal.${next.key}`, businessType))}
        action={t(stepMessageKey(`step.action.${next.key}`, businessType))}
        href={next.href}
        remaining={t("step.remaining", { count: progress.total - progress.done })}
        back={
          previous && {
            label: t("step.back", {
              step: t(stepMessageKey(`onboarding.${previous.key}`, businessType)),
            }),
            href: previous.href,
          }
        }
      />
    </main>
  );
}
