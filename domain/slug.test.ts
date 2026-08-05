import { describe, expect, test } from "vitest";

import { checkSlug, isValidSlug, RESERVED_SLUGS, slugify } from "@/domain/slug";

describe("slugify", () => {
  test("transliterates Cyrillic rather than percent-encoding it", () => {
    // `/book/студия-ирина` in an SMS is forty unreadable characters, and a
    // salon cannot dictate that over the phone.
    expect(slugify("Студия Ирина")).toBe("studiya-irina");
    expect(slugify("Ногтевой сервис")).toBe("nogtevoi-servis");
  });

  test("handles Romanian diacritics", () => {
    expect(slugify("Frumusețe și Îngrijire")).toBe("frumusete-si-ingrijire");
  });

  test("collapses punctuation and trims the edges", () => {
    expect(slugify("  Nail & Profit — Studio!  ")).toBe("nail-profit-studio");
    expect(slugify("---")).toBe("");
  });

  test("truncates without leaving a trailing hyphen", () => {
    const long = slugify("a".repeat(39) + " " + "b".repeat(20));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  test("what it produces is valid, so the suggestion is usable as offered", () => {
    for (const name of ["Студия Ирина", "Nail Profit", "Frumusețe"]) {
      expect(isValidSlug(slugify(name))).toBe(true);
    }
  });
});

describe("checkSlug", () => {
  test("accepts the shape a client can type", () => {
    expect(checkSlug("studio-irina")).toBeNull();
    expect(checkSlug("nail42")).toBeNull();
  });

  test("names the reason instead of a bare rejection", () => {
    expect(checkSlug("ab")).toBe("too_short");
    expect(checkSlug("a".repeat(41))).toBe("too_long");
    expect(checkSlug("Studio")).toBe("invalid_characters");
    expect(checkSlug("studio_irina")).toBe("invalid_characters");
    expect(checkSlug("-studio")).toBe("invalid_characters");
    expect(checkSlug("studio-")).toBe("invalid_characters");
    expect(checkSlug("studio--irina")).toBe("invalid_characters");
    expect(checkSlug("студия")).toBe("invalid_characters");
  });

  test("a slug may not shadow a path the application serves", () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(checkSlug(reserved)).toBe("reserved");
    }
  });
});
