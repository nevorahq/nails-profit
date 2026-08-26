import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { commissionRules, invitations, memberships, services } from "@/db/schema";
import { PG_ERROR } from "@/lib/db-errors";
import { adminDb, assertCleanupCoversEveryTable, resetDatabase } from "../helpers/database";
import { expectDatabaseError } from "../helpers/expect-database-error";
import {
  createOrganization,
  createService,
  createSpecialist,
  createUser,
} from "../helpers/factories";

/**
 * Constraints are the layer that survives a buggy handler, so they are checked
 * against a real PostgreSQL rather than mocked. Until now every one of these was
 * verified by hand in psql, which meant the verification vanished with the
 * session.
 */
describe("database constraints", () => {
  let organizationId: string;

  beforeAll(assertCleanupCoversEveryTable);

  beforeEach(async () => {
    await resetDatabase();
    organizationId = (await createOrganization()).id;
  });

  it("refuses a commission rule whose shape contradicts its type", async () => {
    const specialist = await createSpecialist(organizationId);

    // Fixed rule carrying a rate.
    await expectDatabaseError(
      adminDb.insert(commissionRules).values({
        organizationId,
        specialistId: specialist.id,
        type: "fixed",
        basisPoints: 4_000,
        fixedAmountMinor: 5_000,
      }),
      { code: PG_ERROR.check, constraint: "commission_rule_shape" },
    );

    // Percentage rule carrying an amount instead of a rate.
    await expectDatabaseError(
      adminDb.insert(commissionRules).values({
        organizationId,
        specialistId: specialist.id,
        type: "percentage",
        fixedAmountMinor: 5_000,
      }),
      { code: PG_ERROR.check, constraint: "commission_rule_shape" },
    );
  });

  it("accepts each well-formed commission rule shape", async () => {
    const specialist = await createSpecialist(organizationId);

    for (const values of [
      { type: "percentage" as const, basisPoints: 4_000, fixedAmountMinor: null },
      { type: "fixed" as const, basisPoints: null, fixedAmountMinor: 12_000 },
    ]) {
      const [rule] = await adminDb
        .insert(commissionRules)
        .values({ organizationId, specialistId: specialist.id, ...values })
        .returning();
      expect(rule.type).toBe(values.type);
    }
  });

  it("refuses a negative commission", async () => {
    const specialist = await createSpecialist(organizationId);

    await expectDatabaseError(
      adminDb.insert(commissionRules).values({
        organizationId,
        specialistId: specialist.id,
        type: "percentage",
        basisPoints: -1,
      }),
      { code: PG_ERROR.check, constraint: "commission_rule_non_negative" },
    );
  });

  it("refuses a zero duration and a negative price on a service", async () => {
    await expectDatabaseError(
      adminDb.insert(services).values({ organizationId, name: { ru: "X" }, durationMinutes: 0 }),
      { code: PG_ERROR.check, constraint: "service_duration_positive" },
    );

    await expectDatabaseError(
      adminDb.insert(services).values({ organizationId, name: { ru: "X" }, priceMinor: -1 }),
      { code: PG_ERROR.check, constraint: "service_price_non_negative" },
    );
  });

  it("allows a service with no price or duration yet", async () => {
    // SRV-007 wants the gap flagged, not the row rejected.
    const service = await createService(organizationId, { priceMinor: null, durationMinutes: null });
    expect(service.priceMinor).toBeNull();
    expect(service.durationMinutes).toBeNull();
  });

  it("refuses the same user joining one organization twice", async () => {
    const user = await createUser();
    await adminDb.insert(memberships).values({ organizationId, userId: user.id, role: "owner" });

    await expectDatabaseError(
      adminDb.insert(memberships).values({ organizationId, userId: user.id, role: "master" }),
      { code: PG_ERROR.unique, constraint: "membership_org_user_idx" },
    );
  });

  it("allows only one pending invitation per address, but re-inviting after revoke", async () => {
    const base = {
      organizationId,
      email: "master@example.com",
      role: "master" as const,
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    const [first] = await adminDb
      .insert(invitations)
      .values({ ...base, tokenHash: randomUUID() })
      .returning();

    await expectDatabaseError(
      adminDb.insert(invitations).values({ ...base, tokenHash: randomUUID() }),
      { code: PG_ERROR.unique, constraint: "invitation_pending_email_idx" },
    );

    // Revoking frees the address: the unique index is partial on status.
    await adminDb
      .update(invitations)
      .set({ status: "revoked" })
      .where(await import("drizzle-orm").then(({ eq }) => eq(invitations.id, first.id)));

    const [second] = await adminDb
      .insert(invitations)
      .values({ ...base, tokenHash: randomUUID() })
      .returning();
    expect(second.status).toBe("pending");
  });

  it("refuses two invitations sharing a token hash", async () => {
    const other = await createOrganization({ name: "Other" });
    const tokenHash = randomUUID();
    const base = { role: "master" as const, expiresAt: new Date(Date.now() + 86_400_000), tokenHash };

    await adminDb.insert(invitations).values({ ...base, organizationId, email: "a@example.com" });

    await expectDatabaseError(
      adminDb.insert(invitations).values({ ...base, organizationId: other.id, email: "b@example.com" }),
      { code: PG_ERROR.unique, constraint: "invitation_token_hash_idx" },
    );
  });

  /*
   * The API bounds this too, but the column is what everything else in the
   * product divides by: a zero here would turn every hourly rate into a
   * division by nothing, and an import or a hand-written UPDATE does not pass
   * through zod.
   */
  it("refuses a practical capacity of zero or above the whole rota", async () => {
    const { organizations } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    for (const basisPoints of [0, 10_001]) {
      await expectDatabaseError(
        adminDb
          .update(organizations)
          .set({ practicalCapacityBasisPoints: basisPoints })
          .where(eq(organizations.id, organizationId)),
        { code: PG_ERROR.check, constraint: "organization_practical_capacity_range" },
      );
    }
  });

  it("keeps financial history alive by refusing to delete an organization that has any", async () => {
    // Section 15.3: erasure anonymizes rather than deletes, and the FKs are what
    // make that the only option.
    await createService(organizationId);
    const { organizations } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    await expectDatabaseError(
      adminDb.delete(organizations).where(eq(organizations.id, organizationId)),
      { code: PG_ERROR.foreignKey },
    );
  });
});
