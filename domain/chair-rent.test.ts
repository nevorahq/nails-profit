import { describe, expect, test } from "vitest";

import { chairRentTotalMinor, selectChairRents, type ChairRentRow } from "@/domain/chair-rent";

function rent(overrides: Partial<ChairRentRow> & Pick<ChairRentRow, "id">): ChairRentRow {
  return {
    specialistId: "renter-a",
    amountMinor: 3_000_00,
    activeFrom: new Date("2026-03-15T10:00:00Z"),
    activeTo: null,
    ...overrides,
  };
}

describe("selectChairRents", () => {
  test("a rent agreed mid-month is owed for that month and every one after", () => {
    const rows = [rent({ id: "a" })];
    expect(selectChairRents(rows, "2026-02")).toEqual([]);
    expect(selectChairRents(rows, "2026-03").map((row) => row.id)).toEqual(["a"]);
    expect(selectChairRents(rows, "2026-09").map((row) => row.id)).toEqual(["a"]);
  });

  test("a rent ended mid-month is still owed for the month it ended in, not after", () => {
    const rows = [rent({ id: "a", activeTo: new Date("2026-06-10T00:00:00Z") })];
    expect(selectChairRents(rows, "2026-06").map((row) => row.id)).toEqual(["a"]);
    expect(selectChairRents(rows, "2026-07")).toEqual([]);
  });

  test("a raise in June leaves May at May's amount, and June at the new one", () => {
    const june = new Date("2026-06-01T00:00:00Z");
    const rows = [
      rent({ id: "old", activeTo: june }),
      rent({ id: "new", amountMinor: 3_500_00, activeFrom: june }),
    ];
    expect(chairRentTotalMinor(selectChairRents(rows, "2026-05"))).toBe(3_000_00);
    expect(chairRentTotalMinor(selectChairRents(rows, "2026-06"))).toBe(3_500_00);
  });

  test("a rent called off before it began was never owed", () => {
    const start = new Date("2026-11-01T00:00:00Z");
    expect(selectChairRents([rent({ id: "a", activeFrom: start, activeTo: start })], "2026-11")).toEqual([]);
  });

  test("two renters are two rents", () => {
    const rows = [rent({ id: "a" }), rent({ id: "b", specialistId: "renter-b", amountMinor: 2_000_00 })];
    expect(chairRentTotalMinor(selectChairRents(rows, "2026-04"))).toBe(5_000_00);
  });
});
