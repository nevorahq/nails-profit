import { GoalPanel } from "@/components/goal-panel";
import type { OnboardingProgress, OnboardingStep } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

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
}: {
  progress: OnboardingProgress;
  /** The step to point at. Resolved by the caller, so this cannot render goal-less. */
  next: OnboardingStep;
  locale: AppLocale;
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
        goal={t(`step.goal.${next.key}` as MessageKey)}
        action={t(`step.action.${next.key}` as MessageKey)}
        href={next.href}
        remaining={t("step.remaining", { count: progress.total - progress.done })}
        back={
          previous && {
            label: t("step.back", { step: t(`onboarding.${previous.key}` as MessageKey) }),
            href: previous.href,
          }
        }
      />
    </main>
  );
}
