import { describe, expect, it } from "vitest";

import {
  can,
  canManageCatalogue,
  canManageRole,
  capabilities,
  hasConstraint,
  memberRoles,
  permissionFor,
  roleCapabilities,
  scopeFor,
  type Capability,
  type MemberRole,
} from "@/domain/rbac";

/**
 * Spec section 18.1 asks for the full matrix of four roles against critical
 * resources. This transcribes section 6.1 independently of the implementation:
 * "-" denied, "rw"/"r" the action set, "own" a self-limited scope, then the
 * constraints. If the module and this table drift apart, one of them is wrong.
 */
const expected: Record<MemberRole, Record<Capability, string>> = {
  owner: {
    organization_settings: "rw all",
    user_management: "rw all",
    clients: "rw all",
    bookings: "rw all",
    services: "rw all",
    expenses: "rw all",
    commissions: "rw all",
    dashboard: "r all",
    campaigns: "rw all",
    data_export: "rw all",
  },
  manager: {
    organization_settings: "-",
    user_management: "rw all exclude_owner",
    clients: "rw all",
    bookings: "rw all",
    services: "rw all",
    expenses: "-",
    commissions: "rw all",
    dashboard: "r all",
    campaigns: "rw all",
    data_export: "-",
  },
  master: {
    organization_settings: "-",
    user_management: "-",
    clients: "rw own",
    bookings: "rw own",
    services: "rw all create_only",
    expenses: "-",
    commissions: "r own",
    dashboard: "r own",
    campaigns: "-",
    data_export: "-",
  },
  analyst: {
    organization_settings: "-",
    user_management: "-",
    clients: "r all exclude_pii",
    bookings: "r all",
    services: "r all",
    expenses: "-",
    commissions: "r all aggregates_only",
    dashboard: "r all aggregates_only",
    campaigns: "r all",
    data_export: "-",
  },
};

function describePermission(role: MemberRole, capability: Capability) {
  const permission = permissionFor(role, capability);
  if (permission.actions.length === 0) return "-";
  const actions = permission.actions.includes("write") ? "rw" : "r";
  return [actions, permission.scope, ...permission.constraints].join(" ");
}

describe("section 6.1 capability matrix", () => {
  for (const role of memberRoles) {
    for (const capability of capabilities) {
      it(`${role} / ${capability}`, () => {
        expect(describePermission(role, capability)).toBe(expected[role][capability]);
      });
    }
  }

  it("covers every role and capability with no gaps", () => {
    for (const role of memberRoles) {
      expect(Object.keys(roleCapabilities[role]).sort()).toEqual([...capabilities].sort());
    }
  });
});

describe("rbac helpers", () => {
  it("denies writes that the matrix only grants for reading", () => {
    expect(can("analyst", "services", "read")).toBe(true);
    expect(can("analyst", "services", "write")).toBe(false);
    expect(can("analyst", "campaigns", "read")).toBe(true);
    expect(can("analyst", "campaigns", "write")).toBe(false);
  });

  it("lets a master add a service without letting them rewrite the catalogue", () => {
    // A new service is a row nobody is costed against yet. An existing one
    // carries the price and duration every other master's margin and commission
    // are computed from, so changing it stays with the catalogue managers.
    expect(can("master", "services", "write")).toBe(true);
    expect(hasConstraint("master", "services", "create_only")).toBe(true);
    expect(canManageCatalogue("master", "services")).toBe(false);

    for (const role of ["owner", "manager"] as const) {
      expect(canManageCatalogue(role, "services")).toBe(true);
      expect(hasConstraint(role, "services", "create_only")).toBe(false);
    }
  });

  it("treats the dashboard as read-only even for an owner", () => {
    expect(can("owner", "dashboard", "write")).toBe(false);
    expect(can("owner", "dashboard", "read")).toBe(true);
  });

  it("reserves organization settings and data export for the owner", () => {
    for (const role of ["manager", "master", "analyst"] as const) {
      expect(can(role, "organization_settings", "read")).toBe(false);
      expect(can(role, "data_export", "read")).toBe(false);
    }
    expect(can("owner", "organization_settings", "write")).toBe(true);
    expect(can("owner", "data_export", "write")).toBe(true);
  });

  it("returns a null scope for a denied capability", () => {
    expect(scopeFor("master", "campaigns")).toBeNull();
    expect(scopeFor("master", "bookings")).toBe("own");
    expect(scopeFor("manager", "bookings")).toBe("all");
  });

  it("hides client PII from an analyst only", () => {
    expect(hasConstraint("analyst", "clients", "exclude_pii")).toBe(true);
    for (const role of ["owner", "manager", "master"] as const) {
      expect(hasConstraint(role, "clients", "exclude_pii")).toBe(false);
    }
  });

  it("keeps a master out of the shared catalogue", () => {
    // The matrix grants a Master a services write, but only to add their own.
    // Catalogue edits are organization-wide, so `can` alone is not enough —
    // this is the check the write endpoints use.
    expect(can("master", "services", "write")).toBe(true);
    expect(canManageCatalogue("master", "services")).toBe(false);

    expect(canManageCatalogue("owner", "services")).toBe(true);
    expect(canManageCatalogue("manager", "services")).toBe(true);
    expect(canManageCatalogue("analyst", "services")).toBe(false);
  });

  it("lets a manager administer everyone except an owner", () => {
    expect(canManageRole("manager", "master")).toBe(true);
    expect(canManageRole("manager", "manager")).toBe(true);
    expect(canManageRole("manager", "analyst")).toBe(true);
    expect(canManageRole("manager", "owner")).toBe(false);
  });

  it("lets an owner administer every role", () => {
    for (const role of memberRoles) {
      expect(canManageRole("owner", role)).toBe(true);
    }
  });

  it("refuses user management to roles that lack it entirely", () => {
    for (const actor of ["master", "analyst"] as const) {
      for (const target of memberRoles) {
        expect(canManageRole(actor, target)).toBe(false);
      }
    }
  });
});
