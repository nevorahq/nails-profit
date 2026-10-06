import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { commissionRules, financialSnapshots } from "@/db/schema";
import { withTenant } from "@/db/tenant";

import { dataOf, errorCodeOf } from "../helpers/api";
import { closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * A chair rented or a salary agreed, and the 0% that follows from it.
 *
 * The studio used to be told, in a hint under the rate field, to write the zero
 * by hand — and the first visit of a renter who had none refused to close with
 * MISSING_COMMISSION_RULE. The rule now follows the cooperation in the same
 * request; going back to a percentage asks for the rate.
 */
let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("cooperation-owner@studio.example", "Cooperation Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

async function openDefaultRules(specialistId: string) {
  return withTenant(studio.organizationId, (tx) =>
    tx
      .select()
      .from(commissionRules)
      .where(
        and(
          eq(commissionRules.specialistId, specialistId),
          isNull(commissionRules.serviceId),
          isNull(commissionRules.activeTo),
        ),
      ),
  );
}

async function closeVisit(specialistId: string) {
  return studio.owner.post("/api/v1/visits", {
    service_id: studio.serviceId,
    specialist_id: specialistId,
    actual_duration_minutes: CANONICAL.serviceDurationMinutes,
  });
}

async function commissionOf(visitId: string) {
  const [snapshot] = await withTenant(studio.organizationId, (tx) =>
    tx
      .select({ commissionMinor: financialSnapshots.commissionMinor })
      .from(financialSnapshots)
      .where(eq(financialSnapshots.visitId, visitId))
      .orderBy(desc(financialSnapshots.snapshotVersion))
      .limit(1),
  );
  return snapshot.commissionMinor;
}

describe("a renter created without a rate", () => {
  test.each(["rent", "staff"] as const)("gets 0%% and closes a visit as a %s master", async (cooperation) => {
    const created = await studio.owner.post("/api/v1/specialists", {
      name: `Без ставки ${cooperation}`,
      cooperation_type: cooperation,
    });
    expect(created.status).toBe(201);
    const { id } = dataOf<{ id: string }>(created);

    const rules = await openDefaultRules(id);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ type: "percentage", basisPoints: 0 });

    const visit = await closeVisit(id);
    expect(visit.status).toBe(201);
    expect(await commissionOf(dataOf<{ id: string }>(visit).id)).toBe(0);
  });

  test("a percentage master created without a rate is still left without one", async () => {
    const { id } = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Процент без ставки" }),
    );
    expect(await openDefaultRules(id)).toHaveLength(0);
    expect(errorCodeOf(await closeVisit(id))).toBe("MISSING_COMMISSION_RULE");
  });

  test("a rate given with a salary is kept — a salary and a bonus is a real arrangement", async () => {
    const { id } = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Оклад и бонус",
        cooperation_type: "staff",
        default_rule: { type: "percentage", basis_points: 500 },
      }),
    );
    const rules = await openDefaultRules(id);
    expect(rules).toHaveLength(1);
    expect(rules[0].basisPoints).toBe(500);
  });
});

describe("changing how an existing master works", () => {
  test("percentage → rent writes 0% in the same request; the visit before keeps its 40%", async () => {
    const { id } = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Был на проценте",
        default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
      }),
    );
    const before = dataOf<{ id: string }>(await closeVisit(id));

    expect((await studio.owner.patch(`/api/v1/specialists/${id}`, { cooperation_type: "rent" })).status).toBe(200);

    const rules = await openDefaultRules(id);
    expect(rules).toHaveLength(1);
    expect(rules[0].basisPoints).toBe(0);

    const after = dataOf<{ id: string }>(await closeVisit(id));
    expect(await commissionOf(before.id)).toBe(CANONICAL.commissionMinor);
    expect(await commissionOf(after.id)).toBe(0);

    // rent → staff: still nothing per visit, and no second zero is written.
    expect((await studio.owner.patch(`/api/v1/specialists/${id}`, { cooperation_type: "staff" })).status).toBe(200);
    expect((await openDefaultRules(id)).map((rule) => rule.id)).toEqual([rules[0].id]);
  });

  test("back to a percentage is refused without a rate, and takes the one given", async () => {
    const { id } = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", { name: "Вернётся", cooperation_type: "rent" }),
    );

    const refused = await studio.owner.patch(`/api/v1/specialists/${id}`, { cooperation_type: "commission" });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("RATE_REQUIRED");
    // Refused whole: the card is still a renter's.
    const [card] = dataOf<{ id: string; cooperation_type: string }[]>(await studio.owner.get("/api/v1/specialists")).filter(
      (row) => row.id === id,
    );
    expect(card.cooperation_type).toBe("rent");

    const accepted = await studio.owner.patch(`/api/v1/specialists/${id}`, {
      cooperation_type: "commission",
      default_rule: { type: "percentage", basis_points: 3_500 },
    });
    expect(accepted.status).toBe(200);
    const rules = await openDefaultRules(id);
    expect(rules).toHaveLength(1);
    expect(rules[0].basisPoints).toBe(3_500);

    const visit = dataOf<{ id: string }>(await closeVisit(id));
    expect(await commissionOf(visit.id)).toBe(21_000);
  });

  test("a rule on a change that is not back to a percentage is ignored", async () => {
    const { id } = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/specialists", {
        name: "Игнор",
        default_rule: { type: "percentage", basis_points: 4_000 },
      }),
    );
    await studio.owner.patch(`/api/v1/specialists/${id}`, {
      cooperation_type: "staff",
      default_rule: { type: "percentage", basis_points: 9_000 },
    });
    const rules = await openDefaultRules(id);
    expect(rules.map((rule) => rule.basisPoints)).toEqual([0]);
  });
});
