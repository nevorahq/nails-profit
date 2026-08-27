import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { dataOf, signUp, type Actor } from "../helpers/api";
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

async function progress() {
  return dataOf<Progress>(await owner.get("/api/v1/onboarding"));
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

    const specialistId = dataOf<{ id: string }>(
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

  test("is not the master's list", async () => {
    // A master may add a service, and still cannot advance «Первый расчёт»:
    // it is the owner's setup, and the panel it sends people back to is not
    // drawn for them.
    const master = await inviteMember(owner, "guide-master@studio.example", "master");

    expect((await master.get("/api/v1/onboarding")).status).toBe(403);
  });
});
