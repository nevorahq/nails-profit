import Link from "next/link";

import { can } from "@/domain/rbac";
import type { Currency } from "@/domain/money";
import { workedExample } from "@/domain/worked-example";
import { registerOf } from "@/i18n/lexicon";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatHours, formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

/**
 * «Как считается»: one studio visit, from its price to what it brings in an
 * hour, and then the month.
 *
 * Every «Подробнее» in the product ends here (`components/hint.tsx`), so the
 * arithmetic is explained once, on numbers, instead of seven times in prose.
 * The numbers come from `domain/worked-example.ts`, which runs them through
 * the costing engine itself — a page that explains a formula must not be able
 * to disagree with it.
 *
 * No figure of the studio is on it, so everybody in a workspace may read it.
 * It speaks in the reader's register like every other screen: the line about
 * what detailed analytics calls «осталось» appears only to whoever has it on,
 * and the note about working alone only to somebody who does.
 */
export default async function HowItIsCountedPage() {
  const workspace = await requireWorkspace();
  const { membership, locale, currency, businessType, detailedAnalytics } = workspace;
  const t = getTranslator(locale, registerOf(workspace));
  const tag = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, tag);
  const example = workedExample(currency as Currency);
  const hours = t("capacity.hours", { value: formatHours(example.durationMinutes, tag) });

  return (
    <main className="app-shell how-page">
      <p className="muted">{t("how.lead")}</p>

      <section className="panel" id="visit">
        <h2>{t("how.visitTitle")}</h2>
        <p>
          {t("how.visitSetup", {
            price: money(example.priceMinor),
            rate: formatBasisPoints(example.commissionBasisPoints, tag),
          })}
        </p>
        <table className="data-table pl-table">
          <tbody>
            <tr>
              <td>{t("how.price")}</td>
              <td>{money(example.priceMinor)}</td>
            </tr>
            <tr>
              <td className="pl-label">
                {t("how.masterPay", { rate: formatBasisPoints(example.commissionBasisPoints, tag) })}
              </td>
              <td>− {money(example.masterPayMinor)}</td>
            </tr>
            <tr className="pl-subtotal">
              <td className="pl-label">{t("how.materials")}</td>
              <td>− {money(example.materialsMinor)}</td>
            </tr>
            <tr className="pl-total">
              <td>{t("how.left")}</td>
              <td>{money(example.leftMinor)}</td>
            </tr>
          </tbody>
        </table>
        <p className="pl-note">{t("how.leftNote")}</p>
        {detailedAnalytics && <p className="pl-note">{t("how.leftDetailed")}</p>}
        {businessType === "solo" && <p className="pl-note">{t("how.solo")}</p>}
      </section>

      <section className="panel" id="hour">
        <h2>{t("how.hourTitle")}</h2>
        <p>
          {t("how.perHour", {
            left: money(example.leftMinor),
            hours,
            perHour: money(example.perHourMinor),
          })}
        </p>
      </section>

      <section className="panel" id="month">
        <h2>{t("how.monthTitle")}</h2>
        <p>
          {t("how.month", {
            visits: example.visitsPerMonth,
            leftAfterVisits: money(example.leftAfterVisitsMinor),
            fixed: money(example.fixedCostsMinor),
          })}
        </p>
        <table className="data-table pl-table">
          <tbody>
            <tr className="pl-total">
              <td>{t("how.monthLeft")}</td>
              <td className={example.leftForMonthMinor < 0 ? "metric-negative" : undefined}>
                {money(example.leftForMonthMinor)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="pl-note">{t("how.monthNote")}</p>
      </section>

      {/* The switch is the owner's, so the paragraph about it is too. */}
      {can(membership.role, "organization_settings", "write") && (
        <section className="panel" id="detailed">
          <h2>{t("how.detailedTitle")}</h2>
          <p>{t("how.detailed")}</p>
          <Link className="text-link" href="/app/settings">
            {t("nav.settings")}
          </Link>
        </section>
      )}
    </main>
  );
}
