import { describe, expect, test } from "vitest";

import { slotTimes, slotsUrl } from "@/components/booking-slots";

const LOCATION = "11111111-1111-4111-8111-111111111111";
const MASTER = "22222222-2222-4222-8222-222222222222";
const MANICURE = "33333333-3333-4333-8333-333333333333";
const PEDICURE = "44444444-4444-4444-8444-444444444444";
const DESIGN = "55555555-5555-4555-8555-555555555555";

const base = {
  locationId: LOCATION,
  specialistId: MASTER,
  date: "2026-11-04",
  lines: [{ serviceId: MANICURE, addOnIds: [] }],
};

describe("slotsUrl", () => {
  test("asks for one service on one date", () => {
    const url = new URL(slotsUrl(base)!, "http://localhost");

    expect(url.pathname).toBe("/api/v1/availability/slots");
    expect(url.searchParams.get("location_id")).toBe(LOCATION);
    expect(url.searchParams.get("specialist_id")).toBe(MASTER);
    expect(url.searchParams.get("date")).toBe("2026-11-04");
    expect(url.searchParams.get("services")).toBe(MANICURE);
  });

  test("keeps an add-on with the service it was chosen for", () => {
    const url = new URL(
      slotsUrl({
        ...base,
        lines: [
          { serviceId: MANICURE, addOnIds: [DESIGN] },
          { serviceId: PEDICURE, addOnIds: [] },
        ],
      })!,
      "http://localhost",
    );

    expect(url.searchParams.get("services")).toBe(`${MANICURE}:${DESIGN}|${PEDICURE}`);
  });

  test("waits for a real date", () => {
    expect(slotsUrl({ ...base, date: "" })).toBeNull();
    expect(slotsUrl({ ...base, date: "2026-11-3" })).toBeNull();
    expect(slotsUrl({ ...base, date: "2026-02-30" })).toBeNull();
  });

  test("waits for a sitting", () => {
    expect(slotsUrl({ ...base, lines: [] })).toBeNull();
  });

  test("waits for a master and an address", () => {
    expect(slotsUrl({ ...base, specialistId: "" })).toBeNull();
    expect(slotsUrl({ ...base, locationId: "" })).toBeNull();
  });
});

describe("slotTimes", () => {
  test("reads each start as the wall clock of the location, not of the viewer", () => {
    // 07:00 UTC is 09:00 in Chișinău in winter (UTC+2) and 10:00 in summer (UTC+3).
    expect(slotTimes(["2026-11-04T07:00:00.000Z"], "Europe/Chisinau")).toEqual(["09:00"]);
    expect(slotTimes(["2026-07-04T07:00:00.000Z"], "Europe/Chisinau")).toEqual(["10:00"]);
  });

  test("keeps the order it was given", () => {
    expect(
      slotTimes(["2026-11-04T07:00:00.000Z", "2026-11-04T07:15:00.000Z"], "UTC"),
    ).toEqual(["07:00", "07:15"]);
  });

  test("is empty for no slots", () => {
    expect(slotTimes([], "UTC")).toEqual([]);
  });
});
