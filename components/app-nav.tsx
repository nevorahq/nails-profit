import Link from "next/link";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import type { MemberRole } from "@/domain/rbac";

const TABS: readonly { href: string; key: MessageKey }[] = [
  { href: "/app", key: "nav.dashboard" },
  { href: "/app/calendar", key: "nav.calendar" },
  { href: "/app/booking", key: "nav.booking" },
  { href: "/app/visits", key: "nav.visits" },
  { href: "/app/clients", key: "nav.clients" },
  { href: "/app/services", key: "nav.services" },
  { href: "/app/add-ons", key: "nav.addOns" },
  { href: "/app/materials", key: "nav.materials" },
  { href: "/app/specialists", key: "nav.specialists" },
  { href: "/app/import", key: "nav.import" },
  { href: "/app/settings", key: "nav.settings" },
];

// Tabs hidden from the master role.
const MASTER_HIDDEN: ReadonlySet<string> = new Set([
  "/app/import",
  "/app/specialists",
  "/app/materials",
  "/app/add-ons",
  "/app/clients",
  "/app/visits",
]);

export async function AppNav({
  active,
  locale,
  role,
}: {
  active: string;
  locale: AppLocale;
  role?: MemberRole;
}) {
  const t = getTranslator(locale);
  const tabs =
    role === "master" ? TABS.filter((tab) => !MASTER_HIDDEN.has(tab.href)) : TABS;

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
