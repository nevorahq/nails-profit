import { describe, expect, it } from "vitest";

import { contactLink, contactWays } from "@/domain/contact-links";

const phone = "+37369384050";

describe("reaching a client from their number", () => {
  /**
   * Each messenger wants the same number in its own shape, and this is the
   * whole of what this module exists to get right: a card that shows one number
   * and opens a chat with another is worse than a card with no links at all.
   */
  it("builds each address in the form that service accepts", () => {
    expect(contactLink("call", phone)).toBe("tel:+37369384050");
    // Bare digits: `wa.me/+373…` is a 404 on WhatsApp's own site.
    expect(contactLink("whatsapp", phone)).toBe("https://wa.me/37369384050");
    expect(contactLink("telegram", phone)).toBe("tg://resolve?phone=37369384050");
    // And Viber wants the plus, encoded, because it is a query parameter.
    expect(contactLink("viber", phone)).toBe("viber://chat?number=%2B37369384050");
  });

  it("puts the one that always works first", () => {
    expect(contactWays(phone).map((way) => way.channel)).toEqual([
      "call",
      "whatsapp",
      "telegram",
      "viber",
    ]);
  });

  it("offers nothing at all where there is no number", () => {
    expect(contactWays(null)).toEqual([]);
    expect(contactWays("")).toEqual([]);
  });

  /**
   * Anything but E.164 produces no link. The column this is built from holds
   * `normalizePhone`'s output and nothing else — but a card rendering a number
   * a person typed, spaces and all, would otherwise dial it verbatim, and some
   * handsets refuse that quietly.
   */
  it.each([
    "+373 69 384050",
    "069384050",
    "37369384050",
    "+373-69-384050",
    "+3736938405012345678",
    "+373",
  ])("refuses %s, which is not the stored shape", (input) => {
    expect(contactLink("call", input)).toBeNull();
    expect(contactWays(input)).toEqual([]);
  });
});
