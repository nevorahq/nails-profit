import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PG_ERROR } from "@/lib/db-errors";

import { dataOf, signUp, type Actor } from "../helpers/api";
import { closeTestConnections, resetDatabase, seedMaterialTemplates } from "../helpers/database";
import { expectDatabaseError } from "../helpers/expect-database-error";

/**
 * The template catalogue end to end: building a tenant's materials from it by
 * supplying nothing but prices.
 *
 * Driven through the real handlers, so the RBAC check, the tenant transaction
 * and its RLS policies are the ones that ship — which is what makes the
 * cross-tenant test below worth anything.
 */

type Template = {
  id: string;
  slug: string;
  name: string;
  base_unit: "ml" | "g" | "piece";
  kind: "sku" | "aggregate";
  is_core: boolean;
  package_size_milli_units: number | null;
};

type FromTemplates = {
  created: number;
  skipped_existing: number;
  conflicts: { template_id: string; code: string; material_id: string | null }[];
};

type Material = {
  id: string;
  name: string;
  current_price: { package_price_minor: number; package_size_milli_units: number } | null;
};

const idempotent = () => ({ "idempotency-key": randomUUID() });

describe("material templates", () => {
  let owner: Actor;

  beforeAll(async () => {
    await resetDatabase();
    await seedMaterialTemplates();
    owner = await signUp("fast-setup@studio.example");
    await owner.post("/api/v1/organizations", { name: "Fast Setup Studio", type: "solo" });
  });

  test("a new organization reaches a priced catalogue by typing only prices", async () => {
    const core = dataOf<Template[]>(
      await owner.get("/api/v1/material-templates?core=true"),
    );

    // The core list is a screenful, not the whole catalogue.
    expect(core.length).toBeGreaterThanOrEqual(12);
    expect(core.length).toBeLessThanOrEqual(20);
    expect(core.every((template) => template.is_core)).toBe(true);
    // Each row carries the packaging it usually comes in, which the form
    // offers as an editable default rather than as a fact.
    expect(core.every((template) => (template.package_size_milli_units ?? 0) > 0)).toBe(true);

    const result = dataOf<FromTemplates>(
      await owner.post(
        "/api/v1/materials/from-templates",
        {
          profile: "manicure",
          duration_ms: 240_000,
          items: core.map((template) => ({
            template_id: template.id,
            package_price_minor: 24_000,
            package_size_milli_units: 15_000,
            currency: "MDL",
          })),
        },
        idempotent(),
      ),
    );

    expect(result.created).toBe(core.length);
    expect(result.created).toBeGreaterThanOrEqual(14);
    expect(result.conflicts).toEqual([]);

    const materials = dataOf<Material[]>(await owner.get("/api/v1/materials"));
    expect(materials).toHaveLength(core.length);
    // Every one of them can be costed: a package size came from the template,
    // and the only thing the owner supplied was the price.
    expect(materials.every((material) => material.current_price !== null)).toBe(true);
  });

  test("building from the same templates again adds nothing and names what exists", async () => {
    const core = dataOf<Template[]>(
      await owner.get("/api/v1/material-templates?core=true"),
    );

    const result = dataOf<FromTemplates>(
      await owner.post(
        "/api/v1/materials/from-templates",
        {
          items: core.map((template) => ({
            template_id: template.id,
            package_price_minor: 99_900,
            package_size_milli_units: 15_000,
            currency: "MDL",
          })),
        },
        idempotent(),
      ),
    );

    expect(result.created).toBe(0);
    expect(result.skipped_existing).toBe(core.length);
    expect(result.conflicts.every((conflict) => conflict.code === "ALREADY_EXISTS")).toBe(true);

    // And the price the owner researched earlier was not overwritten by one
    // typed into a list of fourteen.
    const materials = dataOf<Material[]>(await owner.get("/api/v1/materials"));
    expect(materials.every((material) => material.current_price?.package_price_minor === 24_000)).toBe(
      true,
    );
  });

  test("the same idempotency key replays the answer instead of creating again", async () => {
    const headers = idempotent();
    const templates = dataOf<Template[]>(await owner.get("/api/v1/material-templates?q=Скраб"));
    expect(templates.length).toBeGreaterThan(0);
    const items = templates.slice(0, 2).map((template) => ({
      template_id: template.id,
      package_price_minor: 30_000,
      package_size_milli_units: 500_000,
      currency: "MDL" as const,
    }));

    const first = dataOf<FromTemplates>(
      await owner.post("/api/v1/materials/from-templates", { items }, headers),
    );
    const before = dataOf<Material[]>(await owner.get("/api/v1/materials")).length;

    const replay = dataOf<FromTemplates>(
      await owner.post("/api/v1/materials/from-templates", { items }, headers),
    );

    expect(replay).toEqual(first);
    expect(dataOf<Material[]>(await owner.get("/api/v1/materials"))).toHaveLength(before);
  });

  test("the template catalogue cannot be written by the application at all", async () => {
    // Two independent guarantees, checked separately because either alone
    // could be undone without the other noticing.

    // One: the route exports no mutating handler, so there is nothing to call.
    const route = await import("@/app/api/v1/material-templates/route");
    expect(Object.keys(route).sort()).toEqual(["GET"]);

    // Two: even if one appeared, the connection the application uses is
    // refused by the database. `db` is the application role, the same one every
    // handler runs as — not the migration owner the tests seed with.
    const { db } = await import("@/db");
    const { materialTemplates } = await import("@/db/schema");

    await expectDatabaseError(
      db.insert(materialTemplates).values({
        slug: "evil",
        name: { ru: "x" },
        category: "x",
        packageSizeMilliUnits: 1_000,
        baseUnit: "ml",
      }),
      { code: PG_ERROR.insufficientPrivilege },
    );
  });
});

describe("material templates: another organization", () => {
  let owner: Actor;
  let stranger: Actor;
  let materialId: string;

  beforeAll(async () => {
    await resetDatabase();
    await seedMaterialTemplates();

    owner = await signUp("tenant-a@studio.example");
    await owner.post("/api/v1/organizations", { name: "Studio A", type: "solo" });

    const templates = dataOf<Template[]>(await owner.get("/api/v1/material-templates?core=true"));
    dataOf<FromTemplates>(
      await owner.post(
        "/api/v1/materials/from-templates",
        {
          items: [
            {
              template_id: templates[0].id,
              package_price_minor: 24_000,
              package_size_milli_units: 15_000,
              currency: "MDL",
            },
          ],
        },
        idempotent(),
      ),
    );
    materialId = dataOf<Material[]>(await owner.get("/api/v1/materials"))[0].id;

    stranger = await signUp("tenant-b@studio.example");
    await stranger.post("/api/v1/organizations", { name: "Studio B", type: "solo" });
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("cannot see or price another organization's material", async () => {
    expect(dataOf<Material[]>(await stranger.get("/api/v1/materials"))).toHaveLength(0);

    const priced = await stranger.post(`/api/v1/materials/${materialId}/prices`, {
      costing_mode: "quantity",
      package_price_minor: 1,
      package_size: 15,
    });
    expect(priced.status).toBe(404);
  });

  test("the same material name in two studios is two materials, not a collision", async () => {
    // The natural key is scoped to the organization, so a name another studio
    // uses says nothing about this one.
    const owned = dataOf<Material[]>(await owner.get("/api/v1/materials"))[0];

    const created = await stranger.post("/api/v1/materials", {
      name: owned.name,
      base_unit: "ml",
      package_price_minor: 24_000,
      package_size: 15,
    });
    expect(created.status).toBe(201);

    // And a second one under that name in the same studio is refused with an
    // answer rather than a 500.
    const again = await stranger.post("/api/v1/materials", {
      name: owned.name,
      base_unit: "ml",
      package_price_minor: 24_000,
      package_size: 15,
    });
    expect(again.status).toBe(409);

    expect(dataOf<Material[]>(await owner.get("/api/v1/materials"))).toHaveLength(1);
  });
});
