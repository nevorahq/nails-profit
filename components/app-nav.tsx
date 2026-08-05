import Link from "next/link";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * One definition of the application's tabs.
 *
 * Previously each page carried its own copy, which is how the Import tab had to
 * be added in eight places and how a ninth page would quietly ship without it.
 */
const TABS: readonly { href: string; key: MessageKey }[] = [
  { href: "/app", key: "nav.dashboard" },
  { href: "/app/visits", key: "nav.visits" },
  { href: "/app/services", key: "nav.services" },
  { href: "/app/add-ons", key: "nav.addOns" },
  { href: "/app/materials", key: "nav.materials" },
  { href: "/app/specialists", key: "nav.specialists" },
  { href: "/app/import", key: "nav.import" },
  { href: "/app/settings", key: "nav.settings" },
];

export function AppNav({ active, locale }: { active: string; locale: AppLocale }) {
  const t = getTranslator(locale);

  return (
    <nav className="tab-nav" aria-label={t("nav.primary")}>
      {TABS.map((tab) => (
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
