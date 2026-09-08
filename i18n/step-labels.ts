import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import type { MessageKey } from "@/i18n/t";

/**
 * The one place a checklist step's message key is decided.
 *
 * Three screens name the same steps — the first-run panel on `/app`, the
 * diagnosis list beneath the dashboard, and the window that opens after a save
 * — and each of them used to build its key by hand: `step.goal.${step.key}`,
 * cast to `MessageKey` because a key assembled at runtime is not one. That was
 * survivable while every step read the same to everybody. It stops being
 * survivable the moment one of them does not: three copies of the same
 * `businessType` conditional, and a fourth screen that quietly gets none.
 *
 * So the assembly stays, and the divergence is a lookup in front of it. A step
 * that is not in the table below resolves exactly as it did — the cast and all
 * — and only the first step is in the table, because only the first step says
 * something that is wrong for a studio of one (`i18n/business-labels.ts`).
 */
const DIVERGES = {
  "step.goal.specialist": businessLabel.stepGoalSpecialist,
  "step.action.specialist": businessLabel.stepActionSpecialist,
  "onboarding.specialist": businessLabel.onboardingSpecialist,
  "onboarding.specialistHint": businessLabel.onboardingSpecialistHint,
} as const;

export function stepMessageKey(key: string, businessType: BusinessType): MessageKey {
  const variants = DIVERGES[key as keyof typeof DIVERGES];
  return variants ? variants[businessType] : (key as MessageKey);
}
