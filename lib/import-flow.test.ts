import { describe, expect, it } from "vitest";

import { importableEntities } from "@/domain/import-templates";
import { memberRoles } from "@/domain/rbac";
import { canImport } from "@/lib/import-flow";

describe("canImport", () => {
  it("lets an owner import everything", () => {
    for (const entity of importableEntities) expect(canImport("owner", entity)).toBe(true);
  });

  it("lets a manager import the catalogue", () => {
    expect(canImport("manager", "material")).toBe(true);
    expect(canImport("manager", "service")).toBe(true);
    expect(canImport("manager", "client")).toBe(true);
  });

  it("refuses a master, whose write is scoped to their own rows", () => {
    // Section 6.1 gives a Master `materials` at scope "own" — recording their
    // own consumption. Bulk-replacing the studio's catalogue is not that, and
    // reading the permission without its scope is exactly how that line gets
    // crossed.
    for (const entity of importableEntities) expect(canImport("master", entity)).toBe(false);
  });

  it("refuses an analyst, who is read-only", () => {
    for (const entity of importableEntities) expect(canImport("analyst", entity)).toBe(false);
  });

  it("gives an answer for every role and entity", () => {
    for (const role of memberRoles) {
      for (const entity of importableEntities) {
        expect(typeof canImport(role, entity)).toBe("boolean");
      }
    }
  });
});
