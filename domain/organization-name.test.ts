import { describe, expect, it } from "vitest";

import { isLatinOrganizationName } from "@/domain/organization-name";

describe("organization names", () => {
  it("accepts the names studios actually use", () => {
    for (const name of ["Studio Belle", "M&M Nails", "Beauty-Lab", "Frumusețe", "Nails 24", "O'Hara"]) {
      expect(isLatinOrganizationName(name)).toBe(true);
    }
  });

  it("refuses Cyrillic, and a name that merely hides it", () => {
    for (const name of ["Студия", "Studio Студия", "Ногти & Co"]) {
      expect(isLatinOrganizationName(name)).toBe(false);
    }
  });

  it("ignores surrounding space, which the schema trims anyway", () => {
    expect(isLatinOrganizationName("  Studio Belle  ")).toBe(true);
  });

  it("refuses emoji and other scripts", () => {
    expect(isLatinOrganizationName("Nails 💅")).toBe(false);
    expect(isLatinOrganizationName("美甲")).toBe(false);
  });
});
