import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { materials, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { resetDatabase } from "../helpers/database";
import { createMaterial, createOrganization, createService } from "../helpers/factories";

/**
 * These run through `@/db`, which connects as the non-owner application role, so
 * row level security is actually in force. Verifying isolation through a
 * connection that can bypass RLS would prove nothing.
 */
describe("tenant isolation", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await resetDatabase();
    orgA = (await createOrganization({ name: "A" })).id;
    orgB = (await createOrganization({ name: "B" })).id;
    await createMaterial(orgA, { name: "A material" });
    await createMaterial(orgB, { name: "B material" });
    await createService(orgA, { name: "A service" });
    await createService(orgB, { name: "B service" });
  });

  it("shows only the current tenant's rows", async () => {
    const seen = await withTenant(orgA, (tx) => tx.select().from(materials));
    expect(seen.map((row) => row.name)).toEqual(["A material"]);
  });

  it("hides another tenant's row even when its id is known", async () => {
    const [target] = await withTenant(orgB, (tx) => tx.select().from(materials));

    const found = await withTenant(orgA, (tx) =>
      tx.select().from(materials).where(eq(materials.id, target.id)),
    );

    // Section 6.2 wants a cross-tenant id to answer 404 rather than 403. RLS
    // makes that automatic: the row is not there to be told about.
    expect(found).toEqual([]);
  });

  it("silently affects nothing when updating another tenant's row", async () => {
    const [target] = await withTenant(orgB, (tx) => tx.select().from(materials));

    const updated = await withTenant(orgA, (tx) =>
      tx.update(materials).set({ name: "hijacked" }).where(eq(materials.id, target.id)).returning(),
    );
    expect(updated).toEqual([]);

    const [after] = await withTenant(orgB, (tx) =>
      tx.select().from(materials).where(eq(materials.id, target.id)),
    );
    expect(after.name).toBe("B material");
  });

  it("refuses to write a row belonging to another tenant", async () => {
    await expect(
      withTenant(orgA, (tx) =>
        tx.insert(materials).values({ organizationId: orgB, name: "smuggled", baseUnit: "ml" }),
      ),
    ).rejects.toThrow();
  });

  it("refuses to move a row to another tenant", async () => {
    const [own] = await withTenant(orgA, (tx) => tx.select().from(materials));

    await expect(
      withTenant(orgA, (tx) =>
        tx.update(materials).set({ organizationId: orgB }).where(eq(materials.id, own.id)),
      ),
    ).rejects.toThrow();
  });

  it("fails closed: without a tenant context nothing is visible", async () => {
    // The single most important property. A query that forgets `withTenant`
    // must return nothing rather than everything.
    const leakedMaterials = await db.select().from(materials);
    const leakedServices = await db.select().from(services);

    expect(leakedMaterials).toEqual([]);
    expect(leakedServices).toEqual([]);
  });

  it("does not leak the context between two sequential transactions", async () => {
    await withTenant(orgA, (tx) => tx.select().from(materials));

    // set_config with `is_local = true` is scoped to its transaction, so the
    // next unscoped query must still see nothing.
    const afterwards = await db.select().from(materials);
    expect(afterwards).toEqual([]);
  });

  it("keeps concurrent tenants apart", async () => {
    const [fromA, fromB] = await Promise.all([
      withTenant(orgA, (tx) => tx.select().from(materials)),
      withTenant(orgB, (tx) => tx.select().from(materials)),
    ]);

    expect(fromA.map((row) => row.name)).toEqual(["A material"]);
    expect(fromB.map((row) => row.name)).toEqual(["B material"]);
  });
});
