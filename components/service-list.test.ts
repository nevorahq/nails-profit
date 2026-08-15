import { describe, expect, test } from "vitest";

import { nameForSubmit } from "@/components/service-list";
import { serviceCatalogue } from "@/domain/service-catalogue";

const pedicure = serviceCatalogue.find((entry) => entry.key === "pedicure")!;

/**
 * `service.name` is localized and the form has one box, so what gets written
 * into the other two languages is a decision rather than a detail.
 */
describe("the name a submitted service carries", () => {
  test("fills all three languages when the catalogue entry is used as-is", () => {
    expect(nameForSubmit("Педикюр", pedicure, "ru")).toEqual({
      ru: "Педикюр",
      ro: "Pedichiură",
      en: "Pedicure",
    });
  });

  test("works the same for an owner working in Romanian", () => {
    expect(nameForSubmit("Pedichiură", pedicure, "ro")).toEqual(pedicure.name);
  });

  test("keeps only the language being typed in once the name is edited", () => {
    // "Педикюр + гель-лак" is this studio's service, not the catalogue's kind
    // of work. Sending the catalogue's Romanian for it would be inventing a
    // translation of a name nobody has translated.
    expect(nameForSubmit("Педикюр + гель-лак", pedicure, "ru")).toEqual({
      ru: "Педикюр + гель-лак",
    });
  });

  test("keeps only the typed language when nothing was picked", () => {
    expect(nameForSubmit("Комплекс", null, "ru")).toEqual({ ru: "Комплекс" });
  });

  test("trims what was typed, so a stray space does not become part of the name", () => {
    expect(nameForSubmit("  Маникюр  ", null, "ru")).toEqual({ ru: "Маникюр" });
  });
});
