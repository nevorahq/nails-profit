"use client";

import { usePathname } from "next/navigation";

import { isActiveSection } from "@/components/nav-link";

/**
 * The page title in the global topbar, picked from the current route rather
 * than passed down from each page — `AppShell` renders once per layout, not
 * once per page, so there is nowhere for a page-specific prop to come from.
 *
 * Titles arrive pre-translated from the server, the same reason `NavLink`
 * takes rendered children instead of a dictionary key: the string is the only
 * thing that needs to reach the browser. Longest matching `href` wins, so
 * `/app/calendar/{id}` still reads «Календарь» rather than falling through to
 * the org name.
 */
export function TopbarTitle({
  titles,
  fallback,
}: {
  titles: readonly { href: string; title: string }[];
  fallback: string;
}) {
  const pathname = usePathname();
  const match = titles
    .filter((entry) => isActiveSection(pathname, entry.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return <h1 className="topbar-title">{match?.title ?? fallback}</h1>;
}
