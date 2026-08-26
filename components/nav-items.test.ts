import { describe, expect, it } from "vitest";

import { bottomNavFor, moreNavFor, navFor, navGroups, navItems } from "@/components/nav-items";
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
      "/app/reports/month",
      "/app/calendar",
      "/app/booking",
      "/app/visits",
      "/app/clients",
      "/app/services",
      "/app/add-ons",
      "/app/expenses",
      "/app/specialists",
      "/app/import",
      "/app/settings",
    ]);
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

  it("offers Затраты and the monthly report to the owner and to nobody else", () => {
    // Both are the owner's ledger of rent and payroll — one as rows, one as a
    // total — and the `expenses` capability denies every other role even the
    // read. A link that can only ever answer "нет доступа" is not worth drawing.
    for (const role of memberRoles) {
      const hrefs = navFor(role).map((item) => item.href);
      expect(hrefs.includes("/app/expenses")).toBe(role === "owner");
      expect(hrefs.includes("/app/reports/month")).toBe(role === "owner");
    }
  });

  it("shows every other section to the roles that are not a master", () => {
    for (const role of memberRoles.filter((r) => r !== "master")) {
      const expected = role === "owner" ? navItems.length : navItems.length - 2;
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

  it("does not match a route that merely starts with the same letters", () => {
    // `/app/add-ons` is not inside `/app/add`, and `/app/services` is not
    // inside `/app/service`.
    expect(isActiveSection("/app/add-ons", "/app/add")).toBe(false);
    expect(isActiveSection("/app/specialists", "/app/special")).toBe(false);
  });

  it("marks exactly one section for every route in the navigation", () => {
    for (const item of navItems) {
      const lit = navItems.filter((candidate) => isActiveSection(item.href, candidate.href));
      expect(lit.map((l) => l.href)).toEqual([item.href]);
    }
  });
});
