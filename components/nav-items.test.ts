import { describe, expect, it } from "vitest";

import { bottomNavFor, moreNavFor, navFor, navGroups, navItems, quickActionsFor } from "@/components/nav-items";
import { isActiveSection } from "@/components/nav-link";
import { memberRoles } from "@/domain/rbac";

/**
 * The navigation is drawn three times — sidebar, bottom bar, «Ещё» — from one
 * array. These are the properties that make that safe: that the three cover the
 * same set, that a role only sees sections useful to it,
 * and that opening a row does not put out the light on the section it belongs
 * to.
 */
describe("navigation", () => {
  it("covers every route the app answers on", () => {
    expect(navItems.map((item) => item.href)).toEqual([
      "/app",
      "/app/calendar",
      "/app/booking",
      "/app/visits",
      "/app/clients",
      "/app/services",
      "/app/expenses",
      "/app/specialists",
      "/app/import",
      "/app/settings",
    ]);
  });

  it("keeps «Мастера» out of a team of one", () => {
    /*
     * Same link, same page, different heading above it. For somebody working
     * alone the section holds one fact — what their own hour is worth — and a
     * «Команда» over it is a team of one; beside «Услуги» and «Затраты» it is
     * what it actually is. Nothing is hidden by this and nothing is added.
     */
    const solo = navFor("owner", "solo");
    const studio = navFor("owner", "studio");

    expect(solo.map((item) => item.href)).toEqual(studio.map((item) => item.href));
    expect(solo.find((item) => item.href === "/app/specialists")?.group).toBe("catalogue");
    expect(studio.find((item) => item.href === "/app/specialists")?.group).toBe("team");
    // The heading itself then has nothing under it, and the sidebar prints no
    // empty groups.
    expect(solo.filter((item) => item.group === "team")).toEqual([]);
  });

  it("means the studio shape when nobody says otherwise", () => {
    expect(navFor("owner")).toEqual(navFor("owner", "studio"));
    expect(bottomNavFor("master")).toEqual(bottomNavFor("master", "studio"));
    expect(moreNavFor("owner")).toEqual(moreNavFor("owner", "studio"));
  });

  it("gives every item a group the sidebar prints", () => {
    const printed = new Set(navGroups.map((group) => group.group));
    expect(navItems.filter((item) => !printed.has(item.group))).toEqual([]);
  });

  it("leaves a master the calendar and nothing that restates it", () => {
    // Visits and clients scope correctly to them, and are still reachable by
    // URL; they are simply not offered. The appointment in the calendar is the
    // same work, and it is where closing a visit happens.
    expect(navFor("master").map((item) => item.href)).toEqual([
      "/app",
      "/app/calendar",
      "/app/booking",
      "/app/services",
      "/app/settings",
    ]);
  });

  it("offers Затраты to the owner and to nobody else", () => {
    // The owner's ledger of rent and payroll, and the `expenses` capability
    // denies every other role even the read. A link that can only ever answer
    // "нет доступа" is not worth drawing.
    for (const role of memberRoles) {
      const hrefs = navFor(role).map((item) => item.href);
      expect(hrefs.includes("/app/expenses")).toBe(role === "owner");
    }
  });

  it("keeps the monthly report a tab of «Отчёт» rather than a section of its own", () => {
    // One question, one door: «Месяц подробно» is drawn by the report's tabs,
    // for the owner alone (`components/report-tabs.test.ts`).
    for (const role of memberRoles) {
      for (const businessType of ["solo", "studio"] as const) {
        const hrefs = navFor(role, businessType).map((item) => item.href);
        expect(hrefs.filter((href) => href.startsWith("/app/reports")), `${role}/${businessType}`).toEqual([]);
      }
    }
  });

  it("shows every other section to the roles that are not a master", () => {
    for (const role of memberRoles.filter((r) => r !== "master")) {
      const expected = role === "owner" ? navItems.length : navItems.length - 1;
      expect(navFor(role)).toHaveLength(expected);
    }
  });

  it("keeps visits and clients for everybody else", () => {
    for (const role of memberRoles.filter((r) => r !== "master")) {
      const hrefs = navFor(role).map((item) => item.href);
      expect(hrefs).toContain("/app/visits");
      expect(hrefs).toContain("/app/clients");
    }
  });

  it("splits each role's sections between the bar and «Ещё» without loss", () => {
    for (const role of memberRoles) {
      const bar = bottomNavFor(role);
      const more = moreNavFor(role);

      expect(bar.length).toBeLessThanOrEqual(4);
      // Nothing counted twice, and nothing dropped.
      expect(bar.filter((item) => more.includes(item))).toEqual([]);
      expect([...bar, ...more].map((i) => i.href).sort()).toEqual(
        navFor(role)
          .map((i) => i.href)
          .sort(),
      );
    }
  });

  it("gives each role and each shape of business its own phone bar", () => {
    /*
     * The owner's fourth slot is the «+» (`quickActionsFor`), so their bar is
     * three sections and «Ещё»; «Визиты» is one tap away there. Everyone else
     * keeps the bar they had. The shape of the business moves no section on
     * or off the bar — only the heading «Мастера» sits under in «Ещё».
     */
    const expected = {
      owner: ["/app", "/app/calendar", "/app/clients"],
      manager: ["/app", "/app/calendar", "/app/visits", "/app/clients"],
      analyst: ["/app", "/app/calendar", "/app/visits", "/app/clients"],
      master: ["/app", "/app/calendar", "/app/booking"],
    } as const;
    for (const role of memberRoles) {
      for (const businessType of ["solo", "studio"] as const) {
        expect(bottomNavFor(role, businessType).map((item) => item.href), `${role}/${businessType}`).toEqual(
          expected[role],
        );
      }
    }
    expect(moreNavFor("owner").map((item) => item.href)).toContain("/app/visits");
  });

  it("puts the owner's three ways in behind «+», and nothing behind it for anyone else", () => {
    expect(quickActionsFor("owner", { bookingOff: false }).map((action) => action.href)).toEqual([
      "/app/calendar#new-booking",
      "/app/visits/new",
      "/app/expenses#add-expense",
    ]);
    for (const role of memberRoles.filter((r) => r !== "owner")) {
      expect(quickActionsFor(role, { bookingOff: false }), role).toEqual([]);
    }
    expect(quickActionsFor(undefined, { bookingOff: false })).toEqual([]);
  });

  it("offers no booking from «+» while the booking module is switched off", () => {
    // The calendar is read-only then and has no form to open; a visit closed
    // without an appointment and an expense do not need the module.
    expect(quickActionsFor("owner", { bookingOff: true }).map((action) => action.href)).toEqual([
      "/app/visits/new",
      "/app/expenses#add-expense",
    ]);
  });

  it("backfills a master's bottom bar rather than leaving it half empty", () => {
    // Two of the four preferred sections are not theirs, so the bar is filled
    // from what is left of the same group — the point of the backfill.
    const bar = bottomNavFor("master").map((item) => item.href);
    expect(bar).toEqual(["/app", "/app/calendar", "/app/booking"]);
  });
});

describe("active section", () => {
  it("lights the section a detail page belongs to", () => {
    expect(isActiveSection("/app/calendar/8f3c", "/app/calendar")).toBe(true);
    expect(isActiveSection("/app/clients/8f3c", "/app/clients")).toBe(true);
    expect(isActiveSection("/app/services/8f3c", "/app/services")).toBe(true);
    expect(isActiveSection("/app/visits/new", "/app/visits")).toBe(true);
  });

  it("does not let Отчёт match every route it is a prefix of", () => {
    expect(isActiveSection("/app", "/app")).toBe(true);
    expect(isActiveSection("/app/calendar", "/app")).toBe(false);
    expect(isActiveSection("/app/settings", "/app")).toBe(false);
  });

  it("keeps Отчёт lit on its own tabs, and only on those", () => {
    expect(isActiveSection("/app/reports/month", "/app")).toBe(true);
    expect(isActiveSection("/app/reports/services", "/app")).toBe(true);
    expect(isActiveSection("/app/reports", "/app")).toBe(false);
    expect(isActiveSection("/app/reportsheet", "/app")).toBe(false);
    for (const item of navItems.filter((candidate) => candidate.href !== "/app")) {
      expect(isActiveSection("/app/reports/month", item.href), item.href).toBe(false);
    }
  });

  it("does not match a route that merely starts with the same letters", () => {
    // `/app/expenses` is not inside `/app/expense`, and `/app/specialists` is
    // not inside `/app/special`.
    expect(isActiveSection("/app/expenses", "/app/expense")).toBe(false);
    expect(isActiveSection("/app/specialists", "/app/special")).toBe(false);
  });

  it("marks exactly one section for every route in the navigation", () => {
    for (const item of navItems) {
      const lit = navItems.filter((candidate) => isActiveSection(item.href, candidate.href));
      expect(lit.map((l) => l.href)).toEqual([item.href]);
    }
  });
});
