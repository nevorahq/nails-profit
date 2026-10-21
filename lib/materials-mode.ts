import { asc, eq } from "drizzle-orm";

import { materialsCostingPeriods, organizations } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import {
  materialsModeFor,
  usesPerServiceMaterials,
  type MaterialsCostingMode,
  type MaterialsModePeriod,
} from "@/domain/materials-mode";
import { toZonedParts } from "@/domain/timezone";

/**
 * The studio's materials modes, read once per request and asked of in memory.
 *
 * Every question here is about a month in the organization's own zone: the
 * month a visit closed in is the one its owner sees it in on the report, which
 * is not necessarily the UTC one at a quarter past midnight.
 */

export type MaterialsModes = Readonly<{
  periods: readonly MaterialsModePeriod[];
  timezone: string;
}>;

/** `YYYY-MM` of an instant, in a zone. */
export function monthIn(at: Date, timezone: string): string {
  const parts = toZonedParts(at, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

/**
 * The history and the zone of one studio.
 *
 * `organization` carries no tenant policy — it is what the policies are keyed
 * on — so it is narrowed by id here explicitly; the periods are narrowed by RLS
 * like every tenant table.
 */
export async function loadMaterialsModes(
  tx: TenantTransaction,
  organizationId: string,
  /**
   * The studio's zone, when the caller already holds it. A page does — it came
   * with the membership — and asking the database again is a round trip across
   * a region for a value it is holding.
   */
  knownTimezone?: string,
): Promise<MaterialsModes> {
  const timezone =
    knownTimezone ??
    (
      await tx
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
    )[0]?.timezone ??
    "UTC";
  const periods = await tx
    .select({ mode: materialsCostingPeriods.mode, effectiveFrom: materialsCostingPeriods.effectiveFrom })
    .from(materialsCostingPeriods)
    .orderBy(asc(materialsCostingPeriods.effectiveFrom));
  return { periods, timezone };
}

/** The mode the month of `at` is counted in. */
export function materialsModeAt(modes: MaterialsModes, at: Date = new Date()): MaterialsCostingMode {
  return materialsModeFor(modes.periods, monthIn(at, modes.timezone));
}

/** Whether the amounts on services count now or from a month already chosen. */
export function showsMaterialsField(modes: MaterialsModes, at: Date = new Date()): boolean {
  return usesPerServiceMaterials(modes.periods, monthIn(at, modes.timezone));
}
