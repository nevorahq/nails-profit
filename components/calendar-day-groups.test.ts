import { describe, expect, test } from "vitest";

import { groupDayByMaster } from "@/components/calendar-day-groups";

type Item = { who: string; at: string };
const of = (item: Item) => item.who;

describe("the day, one run per master", () => {
  test("follows the roster's order, not the clock's", () => {
    const items: Item[] = [
      { who: "vera", at: "09:00" },
      { who: "anna", at: "10:00" },
      { who: "vera", at: "11:00" },
    ];
    const groups = groupDayByMaster(items, of, ["anna", "vera"]);
    expect(groups.map((group) => group.specialistId)).toEqual(["anna", "vera"]);
  });

  test("keeps each master's entries in the order they came", () => {
    const items: Item[] = [
      { who: "anna", at: "09:00" },
      { who: "vera", at: "09:30" },
      { who: "anna", at: "12:00" },
    ];
    const [anna] = groupDayByMaster(items, of, ["anna", "vera"]);
    expect(anna.items.map((item) => item.at)).toEqual(["09:00", "12:00"]);
  });

  test("leaves out a master with nothing on the day", () => {
    const groups = groupDayByMaster([{ who: "vera", at: "09:00" }], of, ["anna", "vera"]);
    expect(groups.map((group) => group.specialistId)).toEqual(["vera"]);
  });

  test("puts somebody off the roster after it, in the order they first appear", () => {
    const items: Item[] = [
      { who: "gone-2", at: "08:00" },
      { who: "anna", at: "09:00" },
      { who: "gone-1", at: "10:00" },
    ];
    const groups = groupDayByMaster(items, of, ["anna"]);
    expect(groups.map((group) => group.specialistId)).toEqual(["anna", "gone-2", "gone-1"]);
  });

  test("an empty day has no runs", () => {
    expect(groupDayByMaster([], of, ["anna"])).toEqual([]);
  });
});
