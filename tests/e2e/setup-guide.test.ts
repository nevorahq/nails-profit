import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, errorCodeOf, signUp, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { inviteMember } from "../helpers/studio";

/**
 * The guided first run, read at the boundary the window reads it at.
 *
 * `tests/integration/onboarding.test.ts` proves what each step measures; this
 * proves the loop the interface is built on — that the count moves by exactly
 * one per finished step, and that «выполнено» arrives at the same moment the
 * product stops refusing to close a visit. The window opens on nothing else:
 * it compares this number before and after each write.
 */
type Progress = {
  done: number;
  total: number;
  complete: boolean;
  next: string | null;
  steps: { key: string; done: boolean; href: string }[];
};

let owner: Actor;
/** Written by the first test, read by the month's rota below. */
let specialistId: string;

async function progress() {
  return dataOf<Progress>(await owner.get("/api/v1/onboarding"));
}

async function monthProgress() {
  return dataOf<Progress>(await owner.get("/api/v1/onboarding/month"));
}

beforeAll(async () => {
  await resetDatabase();
  owner = await signUp("guide-owner@studio.example");
  await owner.post("/api/v1/organizations", {
    name: "Guide Studio",
    type: "solo",
    currency: "MDL",
    locale: "ru",
  });
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("the guided setup", () => {
  test("walks a new studio one step at a time to its first calculation", async () => {
    const empty = await progress();
    expect(empty).toMatchObject({ done: 0, total: 3, complete: false, next: "specialist" });
    // The step the window links to, and the reason the panel's first link was
    // wrong for as long as it pointed at «Настройки».
    expect(empty.steps[0].href).toBe("/app/specialists#add-specialist");

    specialistId = dataOf<{ id: string }>(
      await owner.post("/api/v1/specialists", {
        name: "Мастер",
        default_rule: { type: "percentage", basis_points: 4_000 },
      }),
    ).id;

    expect(await progress()).toMatchObject({ done: 1, complete: false, next: "service" });

    const serviceId = dataOf<{ id: string }>(
      await owner.post("/api/v1/services", {
        name: { ru: "Маникюр" },
        price_minor: 60_000,
        duration_minutes: 90,
      }),
    ).id;

    expect(await progress()).toMatchObject({ done: 2, complete: false, next: "visit" });

    expect((await owner.post("/api/v1/visits", { service_id: serviceId, specialist_id: specialistId })).status)
      .toBe(201);

    // The third step, and the end of the guided run: this is the state the
    // window reports as «готово» instead of «осталось».
    expect(await progress()).toMatchObject({ done: 3, total: 3, complete: true, next: null });
  });

  test("catalogues the owner as their own master when they say so", async () => {
    /*
     * A solo studio is one person wearing both hats, and until «это я» the
     * product could not be told: `specialist.user_id` is what every "own" scope
     * resolves through — the calendar, the visits, the notification that a
     * client just booked them — and `is_principal` is what returns their
     * commission to the month's profit. Both were set afterwards, from two
     * different screens, or not at all.
     */
    const rows = dataOf<{ id: string; user_id: string | null; is_principal: boolean }[]>(
      await owner.get("/api/v1/specialists"),
    );
    const mine = rows.find((row) => row.id === specialistId);
    expect(mine).toMatchObject({ user_id: null, is_principal: false });

    const linked = dataOf<{ id: string }>(
      await owner.post("/api/v1/specialists", {
        name: "Владелец",
        default_rule: { type: "percentage", basis_points: 5_000 },
        is_me: true,
      }),
    );

    const after = dataOf<{ id: string; user_id: string | null; is_principal: boolean }[]>(
      await owner.get("/api/v1/specialists"),
    ).find((row) => row.id === linked.id);
    expect(after).toMatchObject({ user_id: owner.userId, is_principal: true });

    // One account, one card: saying it twice is refused by name rather than by
    // a unique-index 500.
    const again = await owner.post("/api/v1/specialists", {
      name: "Владелец снова",
      default_rule: { type: "percentage", basis_points: 5_000 },
      is_me: true,
    });
    expect(again.status).toBe(409);
    expect(errorCodeOf(again)).toBe("SPECIALIST_ALREADY_LINKED");
  });

  test("refuses a studio name that is not in Latin script", async () => {
    /*
     * The rule the workspace form states under its own field, enforced where it
     * cannot be walked around: this endpoint creates studios, and the settings
     * endpoint renames them, without ever meeting that form.
     */
    const refused = await owner.post("/api/v1/organizations", {
      name: "Студия Белль",
      type: "solo",
      currency: "MDL",
      locale: "ru",
    });

    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");
  });

  test("does not move on a second service, having already counted the first", async () => {
    const before = await progress();

    await owner.post("/api/v1/services", {
      name: { ru: "Педикюр" },
      price_minor: 80_000,
      duration_minutes: 120,
    });

    // The window is opened by the count moving. If catalogue work alone opened
    // it, a studio typing in twenty services would be sent to the dashboard
    // twenty times.
    expect((await progress()).done).toBe(before.done);
  });

  test("hands the month its own two steps once the first run is over", async () => {
    /*
     * The second checklist, and the reason it is a separate list rather than
     * steps four and five: it is measured for one month, and both figures are
     * ones the report is wrong without. Until they are in, operating profit
     * equals the contribution margin and there is no break-even beside it.
     */
    const month = new Date().toISOString().slice(0, 7);
    expect(await monthProgress()).toMatchObject({
      done: 0,
      total: 2,
      complete: false,
      next: "overhead",
    });

    await owner.post("/api/v1/expenses", {
      name: "Аренда",
      category: "rent",
      amount_minor: 500_000,
      spent_on: `${month}-05`,
    });

    // Overhead alone, and only this month's: `loadMonthSetup` reads the ledger
    // the way the report does rather than counting rows.
    expect(await monthProgress()).toMatchObject({ done: 1, complete: false, next: "rota" });

    const locationId = dataOf<{ id: string }>(
      await owner.post("/api/v1/locations", { name: "Центр", slug: "guide-centru" }),
    ).id;
    await owner.put(`/api/v1/specialists/${specialistId}/locations`, {
      location_ids: [locationId],
    });
    await owner.put("/api/v1/availability/rules", {
      specialist_id: specialistId,
      location_id: locationId,
      effective_from: `${month}-01`,
      intervals: [{ weekday: 1, start: "09:00", end: "18:00" }],
    });

    expect(await monthProgress()).toMatchObject({ done: 2, total: 2, complete: true, next: null });
  });

  test("is not the master's list", async () => {
    // A master may add a service, and still cannot advance «Первый расчёт»:
    // it is the owner's setup, and the panel it sends people back to is not
    // drawn for them.
    const master = await inviteMember(owner, "guide-master@studio.example", "master");

    expect((await master.get("/api/v1/onboarding")).status).toBe(403);
    // The month's list is narrower still: its first step is the expense
    // register, which no role but the owner may even read.
    expect((await master.get("/api/v1/onboarding/month")).status).toBe(403);
  });
});
