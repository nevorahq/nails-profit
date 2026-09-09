import { describe, expect, it } from "vitest";

import { specialistOptions } from "@/lib/specialist-options";

const IRINA = { id: "a", name: "Ирина" };
const OLGA = { id: "b", name: "Ольга" };

describe("specialistOptions", () => {
  it("offers the roster unchanged when it already names the current one", () => {
    expect(specialistOptions([IRINA, OLGA], IRINA)).toEqual([
      { ...IRINA, archived: false },
      { ...OLGA, archived: false },
    ]);
  });

  it("keeps a master who has left, so not touching the field changes nothing", () => {
    /*
     * The whole point. Without the row's own person among the options a
     * browser selects the first one and reports it, so a reschedule that only
     * moved the time handed the appointment to Ольга.
     */
    const options = specialistOptions([OLGA], IRINA);

    expect(options[0]).toEqual({ ...IRINA, archived: true });
    expect(options.map((option) => option.id)).toEqual(["a", "b"]);
  });

  it("still works when everyone has gone", () => {
    // A studio that archived its whole roster still has appointments in the
    // calendar, and the form still has to say whose they are.
    expect(specialistOptions([], IRINA)).toEqual([{ ...IRINA, archived: true }]);
  });

  it("does not duplicate somebody who is both current and live", () => {
    expect(specialistOptions([IRINA], IRINA).filter((o) => o.id === "a")).toHaveLength(1);
  });
});
