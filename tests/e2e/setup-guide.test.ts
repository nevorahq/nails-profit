import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, errorCodeOf, signUp, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { inviteMember } from "../helpers/studio";

/**
 * The guided first run, read at the boundary the window reads it at.
 *
 * `tests/integration/onboarding.test.ts` proves what each step measures; this
 * proves the loop the interface is built on — that the count moves by exactly
 * one per finished step, and that «выполнено» arrives as soon as the studio can
 * be costed rather than after it has sold something. The window opens on
 * nothing else: it compares this number before and after each write.
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
    /*
     * A solo workspace arrives with its owner already catalogued, so the first
     * step is no longer «Добавьте мастера» — there is a master, and what is
     * missing is the one fact nobody else can supply: what that work is worth.
     */
    const cards = dataOf<{ id: string; user_id: string | null; is_principal: boolean }[]>(
      await owner.get("/api/v1/specialists"),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ user_id: owner.userId, is_principal: true });
    specialistId = cards[0].id;

    const empty = await progress();
    expect(empty).toMatchObject({ done: 0, total: 2, complete: false, next: "specialist" });
    // The card, not the hiring form. The panel's first link pointed at
    // «Настройки» for as long as the panel existed, then at `#add-specialist`
    // — which is a form for taking somebody on, and the studio of one has
    // nobody left to take on.
    expect(empty.steps[0].href).toBe(`/app/specialists/${specialistId}`);

    expect(
      (
        await owner.post(`/api/v1/specialists/${specialistId}/commission-rules`, {
          type: "percentage",
          basis_points: 4_000,
        })
      ).status,
    ).toBe(201);

    expect(await progress()).toMatchObject({ done: 1, complete: false, next: "service" });

    const serviceId = dataOf<{ id: string }>(
      await owner.post("/api/v1/services", {
        name: { ru: "Маникюр" },
        price_minor: 60_000,
        duration_minutes: 90,
      }),
    ).id;

    // The second step and the last one: the studio can now be costed, so the
    // window reports «готово» instead of «осталось» — before a single client
    // has walked in.
    expect(await progress()).toMatchObject({ done: 2, total: 2, complete: true, next: null });

    expect((await owner.post("/api/v1/visits", { service_id: serviceId, specialist_id: specialistId })).status)
      .toBe(201);

    /*
     * And the visit changes nothing here, which is the point of it no longer
     * being a step. «Закройте первый визит» used to be the third one: a
     * checklist asking the studio to invent a client to earn a tick, on the
     * grounds that nothing in the product said a number until one existed.
     * Something does now — the costing of the catalogue above.
     */
    expect(await progress()).toMatchObject({ done: 2, total: 2, complete: true, next: null });
  });

  test("has nothing left for «это я» to say in a studio of one", async () => {
    /*
     * The two facts «это я» exists to write are already true of the card the
     * workspace came with: `specialist.user_id`, which every "own" scope
     * resolves through — the calendar, the visits, the notification that a
     * client just booked them — and `is_principal`, which returns the
     * commission to the month's profit. Asked a second time, the product
     * refuses by name rather than with a unique-index 500, and the form stops
     * offering the tick at all once the account has a card.
     */
    const again = await owner.post("/api/v1/specialists", {
      name: "Владелец снова",
      default_rule: { type: "percentage", basis_points: 5_000 },
      is_me: true,
    });
    expect(again.status).toBe(409);
    expect(errorCodeOf(again)).toBe("SPECIALIST_ALREADY_LINKED");
  });

  test("still lets a studio's owner catalogue themselves by hand", async () => {
    /*
     * A studio is not given a card, because which of its masters is the owner
     * — or whether the owner stands at a table at all — is exactly what
     * `organization.type` cannot answer. So «это я» is still the way that is
     * said, and it still writes both facts at once.
     */
    const hybrid = await signUp("guide-hybrid-owner@studio.example");
    await hybrid.post("/api/v1/organizations", {
      name: "Hybrid Studio",
      type: "studio",
      currency: "MDL",
      locale: "ru",
    });

    expect(dataOf<unknown[]>(await hybrid.get("/api/v1/specialists"))).toHaveLength(0);

    const linked = dataOf<{ id: string }>(
      await hybrid.post("/api/v1/specialists", {
        name: "Владелец",
        default_rule: { type: "percentage", basis_points: 5_000 },
        is_me: true,
      }),
    );

    const after = dataOf<{ id: string; user_id: string | null; is_principal: boolean }[]>(
      await hybrid.get("/api/v1/specialists"),
    ).find((row) => row.id === linked.id);
    expect(after).toMatchObject({ user_id: hybrid.userId, is_principal: true });
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
