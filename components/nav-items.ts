import type { MemberRole } from "@/domain/rbac";
import type { MessageKey } from "@/i18n/t";

/**
 * The one description of the navigation, shared by the desktop sidebar, the
 * mobile bottom bar and the «Ещё» screen.
 *
 * Three renderers over one array rather than three arrays: the failure this
 * prevents is the quiet one, where a section is added to the sidebar and the
 * phone never grows it, so the same role has a different product depending on
 * the width of the screen it is looked at through.
 *
 * The order and the hrefs are the ones the routes already answer on. Nothing
 * here decides access — `visibleTo` mirrors the tab list this replaced, and the
 * pages themselves still ask `can()` before they render anything (section 6.1:
 * hiding a link is not access control).
 */
export type NavGroup = "primary" | "work" | "catalogue" | "team" | "admin";

export type NavItem = Readonly<{
  href: string;
  key: MessageKey;
  group: NavGroup;
  /** Which drawing to use from `components/icons`. */
  icon: IconName;
}>;

export type IconName =
  | "report"
  | "monthReport"
  | "calendar"
  | "booking"
  | "visits"
  | "clients"
  | "services"
  | "expenses"
  | "specialists"
  | "import"
  | "settings"
  | "more";

export const navItems: readonly NavItem[] = [
  { href: "/app", key: "nav.dashboard", group: "primary", icon: "report" },
  { href: "/app/reports/month", key: "nav.monthReport", group: "primary", icon: "monthReport" },

  { href: "/app/calendar", key: "nav.calendar", group: "work", icon: "calendar" },
  { href: "/app/booking", key: "nav.booking", group: "work", icon: "booking" },
  { href: "/app/visits", key: "nav.visits", group: "work", icon: "visits" },
  { href: "/app/clients", key: "nav.clients", group: "work", icon: "clients" },

  { href: "/app/services", key: "nav.services", group: "catalogue", icon: "services" },
  { href: "/app/expenses", key: "nav.expenses", group: "catalogue", icon: "expenses" },

  { href: "/app/specialists", key: "nav.specialists", group: "team", icon: "specialists" },

  { href: "/app/import", key: "nav.import", group: "admin", icon: "import" },
  { href: "/app/settings", key: "nav.settings", group: "admin", icon: "settings" },
];

/** The group headings, in the order the sidebar prints them. */
export const navGroups: readonly { group: NavGroup; key: MessageKey | null }[] = [
  { group: "primary", key: null },
  { group: "work", key: "nav.groupWork" },
  { group: "catalogue", key: "nav.groupCatalogue" },
  { group: "team", key: "nav.groupTeam" },
  { group: "admin", key: null },
];

/**
 * Sections a master is not offered.
 *
 * The first three are organization-wide and were never theirs. Visits and
 * clients are different: their pages do scope correctly to the master's own
 * rows, and they were kept for that reason — but the master's day is the
 * calendar, where the appointment they are about to work is also the thing they
 * close into a visit. Two more sections listing the same work from other angles
 * made the product look larger than the job.
 *
 * Hidden, not forbidden. The pages still answer on a typed URL and still scope
 * to the person asking; section 6.1 is explicit that a missing link is not
 * access control. Closing a visit for somebody who walked in without an
 * appointment lives on `/app/visits/new` and is now the owner's to do.
 */
const MASTER_HIDDEN: ReadonlySet<string> = new Set([
  "/app/import",
  "/app/specialists",
  "/app/visits",
  "/app/clients",
]);

/**
 * Sections nobody but the owner is offered.
 *
 * Затраты is the whole of its page — rent, payroll, what the business pays —
 * and the `expenses` capability grants it to the owner alone, reading included.
 * Elsewhere this file leaves a link in place and lets the page refuse, because
 * those pages still show the role *something*. This one would show a refusal
 * and nothing else, so the link goes too.
 */
const OWNER_ONLY: ReadonlySet<string> = new Set(["/app/expenses", "/app/reports/month"]);

export function navFor(role?: MemberRole): readonly NavItem[] {
  return navItems.filter((item) => {
    if (OWNER_ONLY.has(item.href) && role !== "owner") return false;
    if (role === "master" && MASTER_HIDDEN.has(item.href)) return false;
    return true;
  });
}

/**
 * What the phone's bottom bar carries, section 6 of the redesign brief. Five
 * slots is the width a thumb can hit at 360 px; the fifth is «Ещё», so four
 * sections are direct and the rest are one tap away.
 *
 * Filtered by role like everything else, which is why it is expressed as a
 * preferred order rather than a second navigation definition.
 */
const BOTTOM_PREFERENCE: readonly string[] = [
  "/app",
  "/app/calendar",
  "/app/visits",
  "/app/clients",
];

export function bottomNavFor(role?: MemberRole): readonly NavItem[] {
  const allowed = navFor(role);
  const chosen = BOTTOM_PREFERENCE.map((href) => allowed.find((item) => item.href === href)).filter(
    (item): item is NavItem => item !== undefined,
  );

  // Backfill keeps four direct destinations if future role rules hide one of
  // the preferred sections.
  const backfill = allowed.filter((item) => !chosen.includes(item) && item.group === "work");
  return [...chosen, ...backfill].slice(0, 4);
}

/** Everything the bottom bar could not fit — the contents of the «Ещё» screen. */
export function moreNavFor(role?: MemberRole): readonly NavItem[] {
  const onBar = new Set(bottomNavFor(role).map((item) => item.href));
  return navFor(role).filter((item) => !onBar.has(item.href));
}
