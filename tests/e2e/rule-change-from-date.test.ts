import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { commissionRules, laborCostRules, taxRules } from "@/db/schema";
import { todayIn } from "@/domain/report-period";
import { addLocalDays, formatLocalDate, localToUtc } from "@/domain/timezone";
import { withTenant } from "@/db/tenant";
import { loadSpecialistCards } from "@/lib/specialist-cards";
import { errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * «Изменить с даты» through the three endpoints that version a rule.
 *
 * One act — a value and the day it starts — written as two rows in one
 * transaction: the rule in force closed at the instant the new one opens.
 * Checked here against the rows themselves, because the property is about the
 * rows: no instant between them that has no rule, and none that has two.
 */
const ZONE = "Europe/Chisinau";
let studio: Studio;

function day(offset: number) {
  return addLocalDays(todayIn(new Date(), ZONE), offset);
}

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("rule-change-owner@studio.example");
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("a commission rule changed from a date", () => {
  test("keeps the old rate until that day's midnight and hands over without a gap", async () => {
    const response = await studio.owner.post(`/api/v1/specialists/${studio.specialistId}/commission-rules`, {
      type: "percentage",
      basis_points: 3_000,
      effective_date: formatLocalDate(day(3)),
    });
    expect(response.status).toBe(201);

    const defaults = await adminDb
      .select()
      .from(commissionRules)
      .where(and(eq(commissionRules.specialistId, studio.specialistId), isNull(commissionRules.serviceId)))
      .orderBy(asc(commissionRules.activeFrom));
    expect(defaults.map((rule) => rule.basisPoints)).toEqual([4_000, 3_000]);

    const [old, next] = defaults;
    const midnight = localToUtc(day(3), 0, ZONE);
    expect(next.activeFrom).toEqual(midnight);
    expect(old.activeTo).toEqual(next.activeFrom);
    expect(next.activeTo).toBeNull();

    // And the card still reads the rate in force, with the change beside it.
    const [card] = await withTenant(studio.organizationId, (tx) =>
      loadSpecialistCards(tx, { id: studio.specialistId }),
    );
    expect(card.default_rule?.basis_points).toBe(4_000);
    expect(card.scheduled_default_rule).toMatchObject({
      basis_points: 3_000,
      active_from: midnight.toISOString(),
    });
  });

  test("refuses a day earlier than the change already scheduled", async () => {
    const refused = await studio.owner.post(`/api/v1/specialists/${studio.specialistId}/commission-rules`, {
      type: "percentage",
      basis_points: 2_500,
      effective_date: formatLocalDate(day(1)),
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("RULE_DATE_BEFORE_CURRENT");
  });

  test("refuses a day that has passed", async () => {
    const refused = await studio.owner.post(`/api/v1/specialists/${studio.specialistId}/commission-rules`, {
      type: "percentage",
      basis_points: 2_500,
      effective_date: formatLocalDate(day(-1)),
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("RULE_DATE_IN_PAST");
  });

  test("refuses something that is not a date", async () => {
    const refused = await studio.owner.post(`/api/v1/specialists/${studio.specialistId}/commission-rules`, {
      type: "percentage",
      basis_points: 2_500,
      effective_date: "2026-02-30",
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("VALIDATION_ERROR");
  });
});

describe("a labour rule changed from a date", () => {
  test("is written now when no day is given, and closes the one before at that instant", async () => {
    const first = await studio.owner.post("/api/v1/labor-costs", {
      recipient: "owner",
      basis: "fixed_monthly",
      amount_minor: 1_500_000,
    });
    expect(first.status).toBe(201);

    const second = await studio.owner.post("/api/v1/labor-costs", {
      recipient: "owner",
      basis: "fixed_monthly",
      amount_minor: 1_800_000,
      effective_date: formatLocalDate(day(10)),
    });
    expect(second.status).toBe(201);

    const rows = await adminDb
      .select()
      .from(laborCostRules)
      .where(eq(laborCostRules.organizationId, studio.organizationId))
      .orderBy(asc(laborCostRules.activeFrom));
    expect(rows.map((row) => row.amountMinor)).toEqual([1_500_000, 1_800_000]);
    expect(rows[0].activeTo).toEqual(rows[1].activeFrom);
    expect(rows[1].activeFrom).toEqual(localToUtc(day(10), 0, ZONE));
  });

  test("refuses to backdate a month", async () => {
    const refused = await studio.owner.post("/api/v1/labor-costs", {
      recipient: "owner",
      basis: "fixed_monthly",
      amount_minor: 1_000_000,
      effective_date: formatLocalDate(day(-30)),
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("RULE_DATE_IN_PAST");
  });
});

describe("a tax rate changed from a date", () => {
  test("hands over at the day's midnight, and a second change must come after it", async () => {
    expect(
      (await studio.owner.post("/api/v1/tax-rules", { kind: "turnover", basis_points: 100 })).status,
    ).toBe(201);
    expect(
      (
        await studio.owner.post("/api/v1/tax-rules", {
          kind: "turnover",
          basis_points: 400,
          effective_date: formatLocalDate(day(5)),
        })
      ).status,
    ).toBe(201);

    const rows = await adminDb
      .select()
      .from(taxRules)
      .where(and(eq(taxRules.organizationId, studio.organizationId), eq(taxRules.kind, "turnover")))
      .orderBy(asc(taxRules.activeFrom));
    expect(rows.map((row) => row.basisPoints)).toEqual([100, 400]);
    expect(rows[0].activeTo).toEqual(rows[1].activeFrom);

    // The same day again would close the scheduled rate at its own start.
    const refused = await studio.owner.post("/api/v1/tax-rules", {
      kind: "turnover",
      basis_points: 300,
      effective_date: formatLocalDate(day(5)),
    });
    expect(refused.status).toBe(422);
    expect(errorCodeOf(refused)).toBe("RULE_DATE_BEFORE_CURRENT");

    const later = await studio.owner.post("/api/v1/tax-rules", {
      kind: "turnover",
      basis_points: 300,
      effective_date: formatLocalDate(day(6)),
    });
    expect(later.status).toBe(201);
    const after = await adminDb
      .select({ basisPoints: taxRules.basisPoints, activeTo: taxRules.activeTo })
      .from(taxRules)
      .where(and(eq(taxRules.organizationId, studio.organizationId), eq(taxRules.kind, "turnover")))
      .orderBy(asc(taxRules.activeFrom));
    expect(after.map((row) => row.basisPoints)).toEqual([100, 400, 300]);
    expect(after.filter((row) => row.activeTo === null)).toHaveLength(1);
  });
});
