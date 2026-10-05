import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { auditEvents, materialsCostingPeriods } from "@/db/schema";

import { dataOf, errorCodeOf } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { CANONICAL, createCanonicalStudio, type Studio } from "../helpers/studio";

/**
 * «Как считать материалы» through its endpoint.
 *
 * From the current month on, never before it; choosing again for a month
 * replaces the choice; and once the current month is counted per service, the
 * service's costing takes the amount on it off its margin.
 */

let studio: Studio;

/** `YYYY-MM` in the studio's zone, the one the endpoint judges «current» by. */
function monthInChisinau(offset = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Chisinau", year: "numeric", month: "2-digit" })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  const index = Number(parts.year) * 12 + Number(parts.month) - 1 + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const choose = (body: Record<string, unknown>) => studio.owner.post("/api/v1/organizations/materials-mode", body);

beforeAll(async () => {
  await resetDatabase();
  studio = await createCanonicalStudio("materials-mode@studio.example", "Mode Studio");
  await studio.owner.patch(`/api/v1/services/${studio.serviceId}`, { materials_minor: 3_500 });
}, 60_000);

afterAll(async () => {
  await closeTestConnections();
});

describe("choosing how materials are counted", () => {
  test("refuses a month before the current one, and a malformed one", async () => {
    const past = await choose({ mode: "per_service", effective_month: monthInChisinau(-1) });
    expect(past.status).toBe(409);
    expect(errorCodeOf(past)).toBe("MATERIALS_MODE_PAST_MONTH");

    for (const body of [
      { mode: "per_service", effective_month: "2026-13" },
      { mode: "recipes", effective_month: monthInChisinau() },
    ]) {
      expect((await choose(body)).status).toBe(422);
    }
    expect(await adminDb.select().from(materialsCostingPeriods)).toHaveLength(0);
  });

  test("replaces the choice for a month already chosen, and audits both", async () => {
    const later = monthInChisinau(2);
    expect((await choose({ mode: "per_service", effective_month: later })).status).toBe(200);
    const again = dataOf<{ mode: string; effective_from: string }>(
      await choose({ mode: "purchases", effective_month: later }),
    );
    expect(again).toEqual({ mode: "purchases", effective_from: `${later}-01` });

    const rows = await adminDb
      .select()
      .from(materialsCostingPeriods)
      .where(eq(materialsCostingPeriods.organizationId, studio.organizationId));
    expect(rows.map((row) => [row.effectiveFrom, row.mode])).toEqual([[`${later}-01`, "purchases"]]);

    const audited = await adminDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "organization.materials_mode_set"));
    expect(audited).toHaveLength(2);
  });

  test("from the current month, costs the service with its materials", async () => {
    const before = dataOf<{ costing: { contribution_margin_minor: number } }>(
      await studio.owner.get(`/api/v1/services/${studio.serviceId}`),
    );
    expect(before.costing.contribution_margin_minor).toBe(CANONICAL.contributionMarginMinor);

    expect((await choose({ mode: "per_service", effective_month: monthInChisinau() })).status).toBe(200);
    const after = dataOf<{ costing: { materials_minor: number; contribution_margin_minor: number } }>(
      await studio.owner.get(`/api/v1/services/${studio.serviceId}`),
    );
    expect(after.costing).toMatchObject({
      materials_minor: 3_500,
      contribution_margin_minor: CANONICAL.contributionMarginMinor - 3_500,
    });
  });
});
