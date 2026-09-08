import type { BusinessType } from "@/i18n/business-labels";

/**
 * Whether a studio of one has forgotten to say which card is its owner.
 *
 * The principal mark is what tells `domain/period-pl.ts` that the commission
 * booked to this person never left the business, so it is added back below the
 * margin. Without it a woman working alone closes visits that cost her own
 * work as money leaving the business, and reads an operating profit understated
 * by all of it — silently, since nothing else on any screen depends on the mark
 * being there.
 *
 * The damage is done at the moment a visit closes, not when the report is read:
 * `master_is_principal` is written into the visit's snapshot so a month already
 * reported keeps the figures it reported. Which is why the warning speaks about
 * the visits still to come rather than about the total on screen — turning the
 * mark back on does not restate what was closed without it.
 *
 * `is_me` sets it when the card is created and can be unticked there, so this
 * is what notices afterwards. Two screens ask the question — the specialist
 * list, where the mark is set, and the monthly report, whose figures it moves —
 * and they must not disagree about the answer, which is why it is written once
 * here rather than twice as a condition.
 *
 * A studio with nobody catalogued yet is not warned: it is still being walked
 * through «Первый расчёт», and a warning about a mark on a card that does not
 * exist answers a question nobody has asked.
 */
export function soloNeedsPrincipal(
  businessType: BusinessType,
  principalFlags: readonly boolean[],
): boolean {
  return (
    businessType === "solo" && principalFlags.length > 0 && !principalFlags.some(Boolean)
  );
}
