import { describe, expect, test } from "vitest";

import { checkSlug, isValidSlug, RESERVED_SLUGS, slugCandidatesFor, slugify } from "@/domain/slug";

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

/**
 * The studio is never asked for its address now: it types a name on the way in
 * and this is what that name becomes. Every one of these is a name somebody
 * really types, and none of them may produce an address the API would refuse.
 */
describe("slugCandidatesFor", () => {
  const first = (name: string) => slugCandidatesFor(name)[0];

  test("gives a studio the transliteration of its own name", () => {
    expect(first("Студия Ирины")).toBe("studiya-iriny");
    expect(first("Nail Bar")).toBe("nail-bar");
    expect(first("Unghii Frumoase")).toBe("unghii-frumoase");
  });

  test("offers a numbered address to whoever registers the same name second", () => {
    expect(slugCandidatesFor("Ногти").slice(0, 3)).toEqual(["nogti", "nogti-2", "nogti-3"]);
  });

  test("falls back to a word that can be dictated when the name leaves nothing", () => {
    // Two letters is under the minimum, and an emoji transliterates to nothing
    // at all. Neither may end up as an address the endpoint refuses.
    expect(first("АБ")).toBe("studio");
    expect(first("💅")).toBe("studio");
    expect(first("!!!")).toBe("studio");
  });

  test("skips an address that would shadow a path the application serves", () => {
    // «Booking» is a plausible studio name and `book`/`booking` are ours.
    expect(first("Booking")).toBe("booking-2");
    expect(first("Admin")).toBe("admin-2");
  });

  test("keeps every candidate valid, long name or short", () => {
    const long = "Ногтевая мастерская Ирины Петровны на Штефан чел Маре";
    for (const candidate of slugCandidatesFor(long)) {
      expect(checkSlug(candidate)).toBeNull();
    }
    for (const candidate of slugCandidatesFor("АБ")) {
      expect(checkSlug(candidate)).toBeNull();
    }
  });
});
