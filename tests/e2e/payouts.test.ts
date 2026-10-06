import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { masterPayouts } from "@/db/schema";

import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, inviteMember, type Studio } from "../helpers/studio";

/**
 * «К выплате» through its endpoint: the owner marks what was handed over, and
 * nobody else reads or writes it. What a payout does to the month's figures is
 * `tests/integration/chair-rent.test.ts`; this is the door to it.
 */
let studio: Studio;

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("payouts-owner@studio.example", "Payouts Studio");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("payouts", () => {
  test("are marked, listed and taken back by the owner", async () => {
    const created = await studio.owner.post("/api/v1/payouts", {
      specialist_id: studio.specialistId,
      amount_minor: 1_500_00,
      currency: "MDL",
      paid_on: "2026-10-05",
      note: "за сентябрь",
    });
    expect(created.status).toBe(201);
    const { id } = dataOf<{ id: string }>(created);

    const listed = dataOf<{ id: string; amount_minor: number; paid_on: string; note: string }[]>(
      await studio.owner.get("/api/v1/payouts?from=2026-10-01&to=2026-10-31"),
    );
    expect(listed).toEqual([
      expect.objectContaining({ id, amount_minor: 1_500_00, paid_on: "2026-10-05", note: "за сентябрь" }),
    ]);
    expect(dataOf<unknown[]>(await studio.owner.get("/api/v1/payouts?from=2026-11-01"))).toEqual([]);

    expect((await studio.owner.delete(`/api/v1/payouts?id=${id}`)).status).toBe(200);
    expect(errorCodeOf(await studio.owner.delete(`/api/v1/payouts?id=${id}`))).toBe("PAYOUT_NOT_FOUND");
  });

  test("refuse nothing paid, and a master from another studio", async () => {
    const zero = await studio.owner.post("/api/v1/payouts", {
      specialist_id: studio.specialistId,
      amount_minor: 0,
      currency: "MDL",
    });
    expect(zero.status).toBe(422);

    const other = await createCanonicalStudio("payouts-other@studio.example", "Other Payouts");
    const foreign = await studio.owner.post("/api/v1/payouts", {
      specialist_id: other.specialistId,
      amount_minor: 100_00,
      currency: "MDL",
    });
    expect(foreign.status).toBe(404);
    expect(errorCodeOf(foreign)).toBe("SPECIALIST_NOT_FOUND");
  });

  test("are the owner's alone, reading included", async () => {
    for (const role of ["manager", "master", "analyst"] as const) {
      const member = await inviteMember(studio.owner, `payouts-${role}@studio.example`, role);
      expect((await member.get("/api/v1/payouts")).status, role).toBe(403);
      expect(
        (await member.post("/api/v1/payouts", { specialist_id: studio.specialistId, amount_minor: 1, currency: "MDL" }))
          .status,
        role,
      ).toBe(403);
    }
  });

  test("leave with the studio's data, and lose their notes when it is deleted", async () => {
    await studio.owner.post("/api/v1/payouts", {
      specialist_id: studio.specialistId,
      amount_minor: 700_00,
      currency: "MDL",
      note: "Марии наличными",
    });

    const exported = dataOf<{ master_payouts: { note: string | null }[]; chair_rents: unknown[] }>(
      await studio.owner.get("/api/v1/organizations/export"),
    );
    expect(exported.master_payouts).toEqual([expect.objectContaining({ note: "Марии наличными" })]);
    expect(exported.chair_rents).toEqual([]);

    expect(
      (await studio.owner.post("/api/v1/organizations/delete", { confirmation_name: "Payouts Studio" })).status,
    ).toBe(200);
    const rows = await adminDb.select().from(masterPayouts).where(eq(masterPayouts.organizationId, studio.organizationId));
    expect(rows).toEqual([expect.objectContaining({ amountMinor: 700_00, note: null })]);
  });
});
