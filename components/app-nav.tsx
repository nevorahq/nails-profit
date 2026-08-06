import Link from "next/link";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

/**
 * One definition of the application's tabs.
 *
 * Previously each page carried its own copy, which is how the Import tab had to
 * be added in eight places and how a ninth page would quietly ship without it.
 */
const TABS: readonly { href: string; key: MessageKey }[] = [
  { href: "/app", key: "nav.dashboard" },
  { href: "/app/calendar", key: "nav.calendar" },
  { href: "/app/visits", key: "nav.visits" },
  { href: "/app/services", key: "nav.services" },
  { href: "/app/add-ons", key: "nav.addOns" },
  { href: "/app/materials", key: "nav.materials" },
  { href: "/app/specialists", key: "nav.specialists" },
  { href: "/app/import", key: "nav.import" },
  { href: "/app/settings", key: "nav.settings" },
];

/**
 * The booking flag is read here rather than passed in by ten pages. A prop that
 * ten callers have to remember is a prop the eleventh page forgets, and the
 * failure — a tab leading to a module this tenant does not have — looks like a
 * broken product rather than a missing argument.
 */
export async function AppNav({ active, locale }: { active: string; locale: AppLocale }) {
  const t = getTranslator(locale);
  const { bookingAccess } = await requireWorkspace();
  const tabs = bookingAccess === "off" ? TABS.filter((tab) => tab.href !== "/app/calendar") : TABS;

  return (
    <nav className="tab-nav" aria-label={t("nav.primary")}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={tab.href === active ? "active" : undefined}
          aria-current={tab.href === active ? "page" : undefined}
        >
          {t(tab.key)}
        </Link>
      ))}
    </nav>
  );
}
