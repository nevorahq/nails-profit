import { describe, expect, it } from "vitest";

import { isLatinOrganizationName, latinizeOrganizationName } from "@/domain/organization-name";

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

/**
 * The studio name nobody types any more.
 *
 * Registration stopped asking for one: the account was created a minute ago
 * under a person's own name, and that name — in whatever alphabet it was
 * written — has to come out as something a client can read on a booking link.
 */
describe("latinising a name the account was created under", () => {
  it("keeps a name that already reads in Latin", () => {
    expect(latinizeOrganizationName("Irina Popescu")).toBe("Irina Popescu");
    expect(latinizeOrganizationName("Frumusețe")).toBe("Frumusețe");
  });

  it("transliterates Cyrillic and keeps the capitals a name has", () => {
    expect(latinizeOrganizationName("Ирина Попеску")).toBe("Irina Popesku");
    expect(latinizeOrganizationName("Женя")).toBe("Zhenya");
  });

  it("produces a name the rule itself accepts", () => {
    for (const written of ["Ирина Попеску", "Анна-Мария", "O'Hara", "Ольга Ж."]) {
      const latinised = latinizeOrganizationName(written);
      expect(latinised, written).not.toBeNull();
      expect(isLatinOrganizationName(latinised!), written).toBe(true);
    }
  });

  it("separates rather than welds what it cannot transliterate", () => {
    // An unknown separator must not turn two words into one.
    expect(latinizeOrganizationName("Ирина\u00A0Попеску")).toBe("Irina Popesku");
  });

  it("gives up rather than registering a studio called «--»", () => {
    // The caller then falls back to the address, and then to a word: a
    // registration must not fail over the name it was not asked for.
    expect(latinizeOrganizationName("美甲")).toBeNull();
    expect(latinizeOrganizationName("💅")).toBeNull();
    expect(latinizeOrganizationName(" ")).toBeNull();
  });

  it("stays inside the length the column and the schema allow", () => {
    expect(latinizeOrganizationName("Ж".repeat(80))!.length).toBeLessThanOrEqual(100);
  });
});
