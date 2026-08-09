import { describe, expect, it } from "vitest";

import { bottomNavFor, moreNavFor, navFor, navGroups, navItems } from "@/components/nav-items";
import { isActiveSection } from "@/components/nav-link";
import { memberRoles } from "@/domain/rbac";

/**
 * The navigation is drawn three times — sidebar, bottom bar, «Ещё» — from one
 * array. These are the properties that make that safe: that the three cover the
 * same set, that a role never sees a section the tab list used to hide from it,
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
      "/app/add-ons",
      "/app/materials",
      "/app/specialists",
      "/app/import",
      "/app/settings",
    ]);
  });

  it("gives every item a group the sidebar prints", () => {
    const printed = new Set(navGroups.map((group) => group.group));
    expect(navItems.filter((item) => !printed.has(item.group))).toEqual([]);
  });

  it("hides from a master exactly what the tab list hid", () => {
    // The list this replaced. A regression here is a master seeing other
    // people's clients in the navigation, which the endpoints refuse anyway —
    // but offering it is still a bug.
    expect(navFor("master").map((item) => item.href)).toEqual([
      "/app",
      "/app/calendar",
      "/app/booking",
      "/app/services",
      "/app/settings",
    ]);
  });

  it("shows every section to the roles that are not a master", () => {
    for (const role of memberRoles.filter((r) => r !== "master")) {
      expect(navFor(role)).toHaveLength(navItems.length);
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

  it("fills the bar for a master, who has neither Визиты nor Клиенты", () => {
    // Two of the four preferred sections are hidden from this role; the bar
    // backfills rather than rendering with gaps in it.
    const bar = bottomNavFor("master").map((item) => item.href);
    expect(bar).toContain("/app");
    expect(bar).toContain("/app/calendar");
    expect(bar).not.toContain("/app/visits");
    expect(bar.length).toBeGreaterThan(2);
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
