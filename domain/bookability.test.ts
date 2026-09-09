import { describe, expect, it } from "vitest";

import { bookabilityOf, unbookableAmong } from "@/domain/bookability";

const CENTRU = "centru";
const BOTANICA = "botanica";

describe("bookabilityOf", () => {
  it("needs an address a client can open, not merely an address", () => {
    // Assigned to a draft address only: the studio sees them on the rota
    // screen, a client never does.
    expect(
      bookabilityOf({
        publishedLocationIds: [CENTRU],
        assignedLocationIds: [BOTANICA],
        rotaLocationIds: [BOTANICA],
      }),
    ).toBe("no_address");
  });

  it("names hours as the thing missing once the address is settled", () => {
    expect(
      bookabilityOf({
        publishedLocationIds: [CENTRU],
        assignedLocationIds: [CENTRU],
        rotaLocationIds: [],
      }),
    ).toBe("no_hours");
  });

  it("wants both facts about the same address", () => {
    /*
     * Assigned to one, rostered at the other. Each half looks filled in on its
     * own screen, and a client can reach them at neither — the exact shape the
     * old «хоть кто-то» checklist reported as ready.
     */
    expect(
      bookabilityOf({
        publishedLocationIds: [CENTRU, BOTANICA],
        assignedLocationIds: [CENTRU],
        rotaLocationIds: [BOTANICA],
      }),
    ).toBe("no_hours");
  });

  it("is satisfied by one published address that has both", () => {
    expect(
      bookabilityOf({
        publishedLocationIds: [CENTRU, BOTANICA],
        assignedLocationIds: [CENTRU, BOTANICA],
        rotaLocationIds: [BOTANICA],
      }),
    ).toBe("bookable");
  });

  it("treats an unassigned master as reachable nowhere", () => {
    // The staff calendar reads an empty assignment list as «works everywhere»;
    // the public page joins on the row and finds nothing. This follows the
    // public page, because it is the client's reach being described.
    expect(
      bookabilityOf({ publishedLocationIds: [CENTRU], assignedLocationIds: [], rotaLocationIds: [] }),
    ).toBe("no_address");
  });
});

describe("unbookableAmong", () => {
  const people = [
    { id: "a", at: [CENTRU], hours: [CENTRU] },
    { id: "b", at: [CENTRU], hours: [] },
    { id: "c", at: [], hours: [] },
  ];
  const facts = (person: (typeof people)[number]) => ({
    assignedLocationIds: person.at,
    rotaLocationIds: person.hours,
  });

  it("names everyone a client cannot reach, and nobody else", () => {
    expect(unbookableAmong(people, [CENTRU], facts).map((person) => person.id)).toEqual(["b", "c"]);
  });

  it("says nothing at all before the page is published", () => {
    // «Опубликуйте адрес» is already on the screen and is an instruction; this
    // would be the same fact restated as an accusation about three people.
    expect(unbookableAmong(people, [], facts)).toEqual([]);
  });
});
