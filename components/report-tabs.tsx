import Link from "next/link";

import { can, type MemberRole } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { queryFor } from "@/lib/filter-bar";

export type ReportTab = "summary" | "services" | "month";

/**
 * The tabs of «Отчёт», and what each one carries over from the one being read.
 *
 * «Итог» and «Услуги» read the same period and the same master, so moving
 * between them keeps both. «Месяц подробно» reads a month: it is handed the one
 * the period is, when the period is one. Nothing set stays nothing set, so the
 * default — the month the studio is in — survives a round trip of tabs.
 *
 * The month is offered only to a role that may read the ledger, through the
 * same capability its page checks — the tab is a convenience, and the page
 * still refuses everybody else on its own.
 */
export function reportTabs(
  role: MemberRole,
  state: Readonly<{ from?: string; to?: string; specialist?: string; month?: string | null }>,
): readonly { tab: ReportTab; href: string; key: MessageKey }[] {
  const period = { from: state.from, to: state.to, specialist: state.specialist };

  return [
    { tab: "summary" as const, href: queryFor("/app", period), key: "report.tabSummary" as const },
    { tab: "services" as const, href: queryFor("/app/reports/services", period), key: "report.tabServices" as const },
    ...(can(role, "expenses", "read")
      ? [
          {
            tab: "month" as const,
            href: queryFor("/app/reports/month", { month: state.month ?? undefined }),
            key: "report.tabMonth" as const,
          },
        ]
      : []),
  ];
}

export function ReportTabs({
  locale,
  role,
  active,
  state,
}: {
  locale: AppLocale;
  role: MemberRole;
  active: ReportTab;
  state: Parameters<typeof reportTabs>[1];
}) {
  const t = getTranslator(locale);

  return (
    <nav className="report-tabs" aria-label={t("report.tabs")}>
      {reportTabs(role, state).map((item) => (
        <Link
          key={item.tab}
          className="report-tab"
          href={item.href}
          aria-current={item.tab === active ? "page" : undefined}
        >
          {t(item.key)}
        </Link>
      ))}
    </nav>
  );
}
