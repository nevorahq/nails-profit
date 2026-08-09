import { NavIcon } from "@/components/icons";
import { moreNavFor, navGroups } from "@/components/nav-items";
import { NavLink } from "@/components/nav-link";
import { getTranslator } from "@/i18n/t";
import { requireWorkspace } from "@/lib/workspace";

/**
 * The rest of the navigation, for the widths where the bottom bar only has room
 * for four sections.
 *
 * A route rather than a bottom sheet. The secondary navigation is seven items
 * in three groups, which is a screen's worth of content rather than a menu's;
 * as a route it gets the back button, deep linking and focus management from
 * the platform instead of from a hydrated overlay, and it reuses the same
 * `navItems` array and the same role filter as the sidebar, so there is still
 * one description of the navigation rather than two.
 *
 * It is reachable at any width — nothing here is hidden from a desktop visitor
 * who types the URL — but the bottom bar that links to it is not, so on a wide
 * screen the sidebar already shows everything this page lists.
 */
export default async function MorePage() {
  const { membership, locale } = await requireWorkspace();
  const t = getTranslator(locale);
  const items = moreNavFor(membership.role);

  return (
    <main className="app-shell">
      <p className="muted">{t("nav.moreLead")}</p>

      <nav className="more-nav" aria-label={t("nav.secondary")}>
        {navGroups.map(({ group, key }) => {
          const groupItems = items.filter((item) => item.group === group);
          if (groupItems.length === 0) return null;

          return (
            <section className={`more-group more-group-${group}`} key={group}>
              {key && <h2 className="sidebar-group-title">{t(key)}</h2>}
              <ul className="more-list">
                {groupItems.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href} className="more-link">
                      <NavIcon name={item.icon} />
                      <span>{t(item.key)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
    </main>
  );
}
