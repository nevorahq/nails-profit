import Link from "next/link";

import { AccountMenu } from "@/components/account-menu";
import { BrandMark, NavIcon } from "@/components/icons";
import { bottomNavFor, navFor, navGroups, type NavItem } from "@/components/nav-items";
import { NavLink } from "@/components/nav-link";
import { TopbarTitle } from "@/components/topbar-title";
import type { MemberRole } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The frame every signed-in screen sits in, replacing the row of eleven tabs
 * that used to be repeated inside each page's header and the eyebrow+`h1`
 * each page used to open with.
 *
 * A full-width topbar carries the brand, the current section's name and the
 * signed-in account at every
 * width — reference 1 of the mobile redesign. Below it, two renderings of the
 * navigation itself: on a wide screen the sections are a grouped column down
 * the left, which is the shape that lets Каталог and Команда read as separate
 * things rather than as more tabs. On a phone the four most-used land in a
 * bottom bar and the rest move to `/app/more` — a route rather than a sheet,
 * so the back button behaves and nothing has to be hydrated to open it.
 *
 * Only one of the sidebar/bottom-bar pair is in the accessibility tree at a
 * time: the media query takes the other out with `display: none`, so a screen
 * reader is never offered the same eleven links twice.
 */
export function AppShell({
  children,
  locale,
  role,
  organizationName,
  userEmail,
}: {
  children: React.ReactNode;
  locale: AppLocale;
  role: MemberRole;
  organizationName: string;
  userEmail: string;
}) {
  const t = getTranslator(locale);
  const items = navFor(role);
  const bottom = bottomNavFor(role);
  const titles = [
    ...items.map((item) => ({ href: item.href, title: t(item.key) })),
    { href: "/app/more", title: t("nav.more") },
  ];

  return (
    <div className="app-shell-root">
      <header className="app-topbar">
        {/*
          Two cells rather than one flat row: at the desktop breakpoint this
          becomes a grid sharing `.app-frame`'s own `264rem` column, so the
          border between brand and title lines up exactly with the sidebar's
          own right edge below it — one continuous divider, not two that
          happen to look close. Below 681px both cells collapse with
          `display: contents`, so the four children read as a single flex row
          again (brand, title, actions).
        */}
        <div className="topbar-brand-cell">
          <Link className="topbar-brand" href="/app">
            <BrandMark />
            <span className="topbar-brand-text">
              <strong>Nail Profit OS</strong>
              <small>{organizationName}</small>
            </span>
          </Link>
        </div>

        <div className="topbar-main-cell">
          <TopbarTitle titles={titles} fallback={organizationName} />

          <div className="topbar-actions">
            <AccountMenu locale={locale} role={role} userEmail={userEmail} />
          </div>
        </div>
      </header>

      <div className="app-frame">
        <aside className="app-sidebar">
          <nav className="sidebar-nav" aria-label={t("nav.primary")}>
            {navGroups.map(({ group, key }) => {
              const groupItems = items.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;

              /*
               * The group name labels the list rather than being a heading. A
               * heading here would sit before the page's own `h1` in the
               * source order — the sidebar precedes `main` — and hand a screen
               * reader «РАБОТА» as the document's first structural landmark.
               * Labelling the `ul` gives the grouping without disturbing that
               * order.
               */
              const labelId = `sidebar-group-${group}`;

              return (
                <div className={`sidebar-group sidebar-group-${group}`} key={group}>
                  {key && (
                    <span className="sidebar-group-title" id={labelId}>
                      {t(key)}
                    </span>
                  )}
                  <ul className="sidebar-list" aria-labelledby={key ? labelId : undefined}>
                    {groupItems.map((item) => (
                      <li key={item.href}>
                        <NavLink href={item.href} className="sidebar-link">
                          <NavIcon name={item.icon} />
                          <span>{t(item.key)}</span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
        </aside>

        <div className="app-main">{children}</div>

        <nav className="bottom-nav" aria-label={t("nav.primary")}>
          <ul>
            {bottom.map((item) => (
              <li key={item.href}>
                <BottomLink item={item} label={t(item.key)} />
              </li>
            ))}
            <li>
              <NavLink href="/app/more" className="bottom-link">
                <NavIcon name="more" />
                <span>{t("nav.more")}</span>
              </NavLink>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  );
}

function BottomLink({ item, label }: { item: NavItem; label: string }) {
  return (
    <NavLink href={item.href} className="bottom-link">
      <NavIcon name={item.icon} />
      <span>{label}</span>
    </NavLink>
  );
}
