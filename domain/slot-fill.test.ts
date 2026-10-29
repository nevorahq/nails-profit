import { describe, expect, test } from "vitest";

import { BOOKING_LINK_TOKEN } from "@/domain/client-return";
import { getTranslator } from "@/i18n/t";
import {
  describeSlotStart,
  rankSlotFill,
  SLOT_FILL_LIMIT,
  slotFillRefusal,
  type SlotFillCandidate,
  type SlotFillWindow,
} from "@/domain/slot-fill";

function candidate(clientId: string, overrides: Partial<SlotFillCandidate> = {}): SlotFillCandidate {
  return {
    clientId,
    name: clientId,
    phone: "+37360000000",
    overdueDays: 10,
    lastSpecialistId: "other",
    serviceIds: [],
    ...overrides,
  };
}

const WINDOW: SlotFillWindow = { specialistId: "irina", serviceIds: ["manicure"], clientId: "cancelled" };

function ids(rows: readonly SlotFillCandidate[], window: SlotFillWindow = WINDOW, limit?: number) {
  return rankSlotFill(rows, window, limit).map((row) => row.clientId);
}

describe("rankSlotFill", () => {
  test("nobody due is nobody to offer the hour to", () => {
    expect(ids([])).toEqual([]);
  });

  test("the client who cancelled is not offered their own hour", () => {
    expect(ids([candidate("cancelled"), candidate("anna")])).toEqual(["anna"]);
  });

  test("a window with no client behind it excludes nobody", () => {
    expect(ids([candidate("anna")], { ...WINDOW, clientId: null })).toEqual(["anna"]);
  });

  test("a client without a number is left out", () => {
    expect(ids([candidate("anna", { phone: null }), candidate("olga")])).toEqual(["olga"]);
  });

  test("a client of this master comes before one of a colleague", () => {
    expect(
      ids([candidate("other-master"), candidate("mine", { lastSpecialistId: "irina", overdueDays: 90 })]),
    ).toEqual(["mine", "other-master"]);
  });

  test("among a master's clients, one who has had the service comes first", () => {
    expect(
      ids([
        candidate("no-service", { lastSpecialistId: "irina" }),
        candidate("had-service", { lastSpecialistId: "irina", serviceIds: ["manicure"], overdueDays: 90 }),
      ]),
    ).toEqual(["had-service", "no-service"]);
  });

  test("the service ranks a stranger's client above another stranger's, but below the master's own", () => {
    expect(
      ids([
        candidate("stranger"),
        candidate("stranger-service", { serviceIds: ["manicure"] }),
        candidate("mine", { lastSpecialistId: "irina" }),
      ]),
    ).toEqual(["mine", "stranger-service", "stranger"]);
  });

  test("any one of the booked services counts as a match", () => {
    expect(
      ids(
        [candidate("pedicure-only", { serviceIds: ["pedicure"] }), candidate("coating", { serviceIds: ["coating"] })],
        { ...WINDOW, serviceIds: ["manicure", "coating"] },
      ),
    ).toEqual(["coating", "pedicure-only"]);
  });

  test("a fresher lapse comes before an older one at the same standing", () => {
    expect(ids([candidate("old", { overdueDays: 60 }), candidate("fresh", { overdueDays: 9 })])).toEqual([
      "fresh",
      "old",
    ]);
  });

  test("equal standing falls back to the name, then the id, so the order never flickers", () => {
    expect(
      ids([
        candidate("c2", { name: "Vera" }),
        candidate("c3", { name: "Anna" }),
        candidate("c1", { name: "Vera" }),
      ]),
    ).toEqual(["c3", "c1", "c2"]);
  });

  test("at most five are offered by default", () => {
    const many = Array.from({ length: SLOT_FILL_LIMIT + 3 }, (_, index) =>
      candidate(`c${index}`, { overdueDays: index }),
    );
    expect(ids(many)).toHaveLength(SLOT_FILL_LIMIT);
    expect(ids(many)[0]).toBe("c0");
  });

  test("an explicit limit is respected, and zero offers nobody", () => {
    const many = [candidate("a"), candidate("b"), candidate("c")];
    expect(ids(many, WINDOW, 2)).toHaveLength(2);
    expect(ids(many, WINDOW, 0)).toEqual([]);
  });

  test("keeps whatever else the caller carried on the row", () => {
    const rows = [{ ...candidate("anna"), locale: "ro" }];
    expect(rankSlotFill(rows, WINDOW)[0].locale).toBe("ro");
  });
});

describe("describeSlotStart", () => {
  // 12:00 UTC on a Saturday: 14:00 in Chișinău (UTC+2 after the October change).
  const start = new Date("2026-10-31T12:00:00.000Z");

  test("reads the hour on the studio's clock, not UTC", () => {
    expect(describeSlotStart(start, "Europe/Chisinau", "ru-MD")).toContain("14:00");
    expect(describeSlotStart(start, "UTC", "ru-MD")).toContain("12:00");
  });

  test("moves to the next day when the studio's clock has crossed midnight", () => {
    const lateEvening = new Date("2026-10-31T22:30:00.000Z");
    expect(describeSlotStart(lateEvening, "Europe/Chisinau", "en-GB")).toBe("Sunday 1 November, 00:30");
  });

  test("names the weekday and month in the client's language", () => {
    expect(describeSlotStart(start, "Europe/Chisinau", "ru-MD")).toMatch(/суббота.*31 октября/);
    expect(describeSlotStart(start, "Europe/Chisinau", "ro-MD")).toMatch(/sâmbătă.*31 octombrie/);
    expect(describeSlotStart(start, "Europe/Chisinau", "en-GB")).toMatch(/Saturday.*31 October/);
  });
});

describe("the message offered with an hour", () => {
  const start = new Date("2026-10-31T12:00:00.000Z");
  const words = {
    name: "Anna",
    studio: "Belle",
    when: describeSlotStart(start, "Europe/Chisinau", "ru-MD"),
    master: "Irina",
    service: "Manicure",
  };

  test.each(["ru", "ro", "en"] as const)("%s carries the hour, the master and the service with a link", (locale) => {
    const say = getTranslator(locale);
    const text = say("slotFill.message", { ...words, link: BOOKING_LINK_TOKEN });
    for (const part of ["Anna", "Belle", "Irina", "Manicure", "14:00", BOOKING_LINK_TOKEN]) {
      expect(text).toContain(part);
    }
  });

  test.each(["ru", "ro", "en"] as const)("%s without a booking page asks to write back instead of showing a link", (locale) => {
    const say = getTranslator(locale);
    const text = say("slotFill.messageNoLink", words);
    for (const part of ["Anna", "Belle", "Irina", "Manicure", "14:00"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain(BOOKING_LINK_TOKEN);
    expect(text).not.toMatch(/\{\w+\}/);
  });
});

describe("slotFillRefusal", () => {
  const now = new Date("2026-10-30T09:00:00.000Z");
  const later = new Date("2026-10-31T11:00:00.000Z");

  test("a cancelled appointment still to come is an hour to offer", () => {
    expect(slotFillRefusal({ status: "cancelled", startsAt: later }, now)).toBeNull();
  });

  test.each(["pending_confirmation", "confirmed", "completed", "no_show"])(
    "a %s appointment still holds its hour",
    (status) => {
      expect(slotFillRefusal({ status, startsAt: later }, now)).toBe("not_cancelled");
    },
  );

  test("a cancelled appointment already begun is too late to offer", () => {
    expect(slotFillRefusal({ status: "cancelled", startsAt: new Date("2026-10-30T08:00:00.000Z") }, now)).toBe(
      "in_past",
    );
  });

  test("the very moment it starts is already past", () => {
    expect(slotFillRefusal({ status: "cancelled", startsAt: now }, now)).toBe("in_past");
  });
});
