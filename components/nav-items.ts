import type { MemberRole } from "@/domain/rbac";
import type { BusinessType } from "@/i18n/business-labels";
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

/**
 * The one section whose group depends on the shape of the business.
 *
 * «Мастера» under a heading called «Команда» is a team of one for somebody
 * working alone — and after `POST /api/v1/organizations` writes their card for
 * them, the page holds exactly one thing: what their own hour is worth, which
 * is a catalogue fact next to the price of a service, not a fact about staff.
 * Nothing is hidden and nothing moves page: the heading above the link is the
 * whole of the difference, and it goes back to «Команда» the day they take
 * somebody on and switch the format.
 */
function groupOf(item: NavItem, businessType: BusinessType): NavGroup {
  if (businessType === "solo" && item.href === "/app/specialists") return "catalogue";
  return item.group;
}

export function navFor(
  role?: MemberRole,
  /**
   * Defaults to the studio shape, which is what every caller meant before
   * there was a choice — and what a caller that has not been told means now.
   */
  businessType: BusinessType = "studio",
): readonly NavItem[] {
  return navItems
    .filter((item) => {
      if (OWNER_ONLY.has(item.href) && role !== "owner") return false;
      if (role === "master" && MASTER_HIDDEN.has(item.href)) return false;
      return true;
    })
    .map((item) => {
      const group = groupOf(item, businessType);
      return group === item.group ? item : { ...item, group };
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

export function bottomNavFor(
  role?: MemberRole,
  businessType: BusinessType = "studio",
): readonly NavItem[] {
  const allowed = navFor(role, businessType);
  const chosen = BOTTOM_PREFERENCE.map((href) => allowed.find((item) => item.href === href)).filter(
    (item): item is NavItem => item !== undefined,
  );

  // Backfill keeps four direct destinations if future role rules hide one of
  // the preferred sections.
  const backfill = allowed.filter((item) => !chosen.includes(item) && item.group === "work");
  return [...chosen, ...backfill].slice(0, 4);
}

/** Everything the bottom bar could not fit — the contents of the «Ещё» screen. */
export function moreNavFor(
  role?: MemberRole,
  businessType: BusinessType = "studio",
): readonly NavItem[] {
  const onBar = new Set(bottomNavFor(role, businessType).map((item) => item.href));
  return navFor(role, businessType).filter((item) => !onBar.has(item.href));
}
