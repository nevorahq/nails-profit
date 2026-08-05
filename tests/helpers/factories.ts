import { randomUUID } from "node:crypto";

import {
  commissionRules,
  materialPriceVersions,
  materials,
  memberships,
  organizations,
  recipeItems,
  recipes,
  services,
  specialists,
  users,
} from "@/db/schema";
import type { CommissionType } from "@/domain/costing";
import type { MemberRole } from "@/domain/rbac";
import { toMilliUnits } from "@/domain/units";
import { adminDb } from "./database";

/**
 * Seeding runs through the admin connection so a fixture can set up two
 * organizations at once; the code under test still reads through the
 * application role.
 */
export async function createUser(email = `${randomUUID()}@example.com`) {
  const [user] = await adminDb
    .insert(users)
    .values({ id: randomUUID(), name: "Test", email })
    .returning();
  return user;
}

export async function createOrganization(options: { name?: string; ownerId?: string; role?: MemberRole } = {}) {
  const [organization] = await adminDb
    .insert(organizations)
    .values({ name: options.name ?? "Test Studio", type: "solo" })
    .returning();

  if (options.ownerId) {
    await adminDb.insert(memberships).values({
      organizationId: organization.id,
      userId: options.ownerId,
      role: options.role ?? "owner",
    });
  }

  return organization;
}

export async function createMaterial(
  organizationId: string,
  options: {
    name?: string;
    baseUnit?: "ml" | "g" | "piece";
    packagePriceMinor?: number;
    packageSize?: number;
    createdBy?: string;
  } = {},
) {
  const [material] = await adminDb
    .insert(materials)
    .values({
      organizationId,
      name: options.name ?? "Material",
      baseUnit: options.baseUnit ?? "ml",
    })
    .returning();

  if (options.packagePriceMinor !== undefined && options.packageSize !== undefined) {
    const owner = options.createdBy ?? (await createUser()).id;
    await adminDb.insert(materialPriceVersions).values({
      organizationId,
      materialId: material.id,
      packagePriceMinor: options.packagePriceMinor,
      packageSizeMilliUnits: toMilliUnits(options.packageSize),
      currency: "MDL",
      createdBy: owner,
    });
  }

  return material;
}

export async function addMaterialPrice(
  organizationId: string,
  materialId: string,
  options: { packagePriceMinor: number; packageSize: number; createdBy: string; validFrom?: Date },
) {
  const [version] = await adminDb
    .insert(materialPriceVersions)
    .values({
      organizationId,
      materialId,
      packagePriceMinor: options.packagePriceMinor,
      packageSizeMilliUnits: toMilliUnits(options.packageSize),
      currency: "MDL",
      createdBy: options.createdBy,
      validFrom: options.validFrom ?? new Date(),
    })
    .returning();
  return version;
}

export async function createService(
  organizationId: string,
  options: { name?: string; priceMinor?: number | null; durationMinutes?: number | null } = {},
) {
  const [service] = await adminDb
    .insert(services)
    .values({
      organizationId,
      name: { ru: options.name ?? "Услуга" },
      priceMinor: options.priceMinor === undefined ? 60_000 : options.priceMinor,
      durationMinutes: options.durationMinutes === undefined ? 90 : options.durationMinutes,
      currency: "MDL",
    })
    .returning();
  return service;
}

export async function createSpecialist(
  organizationId: string,
  options: { name?: string; userId?: string } = {},
) {
  const [specialist] = await adminDb
    .insert(specialists)
    .values({
      organizationId,
      name: options.name ?? "Мастер",
      userId: options.userId ?? null,
    })
    .returning();
  return specialist;
}

export async function createCommissionRule(
  organizationId: string,
  specialistId: string,
  options: {
    type?: CommissionType;
    basisPoints?: number | null;
    fixedAmountMinor?: number | null;
    serviceId?: string | null;
    activeFrom?: Date;
    activeTo?: Date | null;
  } = {},
) {
  const type = options.type ?? "percentage";
  const [rule] = await adminDb
    .insert(commissionRules)
    .values({
      organizationId,
      specialistId,
      serviceId: options.serviceId ?? null,
      type,
      basisPoints: type === "fixed" ? null : (options.basisPoints ?? 4_000),
      fixedAmountMinor: type === "fixed" ? (options.fixedAmountMinor ?? 10_000) : null,
      activeFrom: options.activeFrom ?? new Date(Date.now() - 60_000),
      activeTo: options.activeTo ?? null,
    })
    .returning();
  return rule;
}

/** Writes a recipe version with its items, the way the recipe endpoint does. */
export async function createRecipe(
  organizationId: string,
  serviceId: string,
  items: { materialId: string; quantity: number }[],
  options: { recipeVersion?: number; activeFrom?: Date } = {},
) {
  const [recipe] = await adminDb
    .insert(recipes)
    .values({
      organizationId,
      serviceId,
      recipeVersion: options.recipeVersion ?? 1,
      activeFrom: options.activeFrom ?? new Date(Date.now() - 60_000),
    })
    .returning();

  if (items.length > 0) {
    await adminDb.insert(recipeItems).values(
      items.map((item) => ({
        organizationId,
        recipeId: recipe.id,
        materialId: item.materialId,
        normativeQuantityMilliUnits: toMilliUnits(item.quantity),
      })),
    );
  }

  return recipe;
}

export async function createAddOn(
  organizationId: string,
  options: { name?: string; priceDeltaMinor?: number; durationDeltaMinutes?: number } = {},
) {
  const { addOns } = await import("@/db/schema");
  const [addOn] = await adminDb
    .insert(addOns)
    .values({
      organizationId,
      name: { ru: options.name ?? "Опция" },
      priceDeltaMinor: options.priceDeltaMinor ?? 0,
      durationDeltaMinutes: options.durationDeltaMinutes ?? 0,
    })
    .returning();
  return addOn;
}

export async function createAddOnRecipe(
  organizationId: string,
  addOnId: string,
  items: { materialId: string; quantity: number }[],
) {
  const [recipe] = await adminDb
    .insert(recipes)
    .values({ organizationId, addOnId, recipeVersion: 1, activeFrom: new Date(Date.now() - 60_000) })
    .returning();

  if (items.length > 0) {
    await adminDb.insert(recipeItems).values(
      items.map((item) => ({
        organizationId,
        recipeId: recipe.id,
        materialId: item.materialId,
        normativeQuantityMilliUnits: toMilliUnits(item.quantity),
      })),
    );
  }
  return recipe;
}

export async function createClient(
  organizationId: string,
  options: { name?: string; normalizedPhone?: string | null; email?: string | null } = {},
) {
  const { clients } = await import("@/db/schema");
  const [client] = await adminDb
    .insert(clients)
    .values({
      organizationId,
      name: options.name ?? "Клиент",
      normalizedPhone: options.normalizedPhone ?? null,
      email: options.email ?? null,
    })
    .returning();
  return client;
}

export async function createVisit(
  organizationId: string,
  options: {
    specialistId: string;
    clientId?: string | null;
    serviceId?: string | null;
    completedAt?: Date;
    plannedDurationMinutes?: number;
    actualDurationMinutes?: number | null;
  },
) {
  const { visits } = await import("@/db/schema");
  const [visit] = await adminDb
    .insert(visits)
    .values({
      organizationId,
      specialistId: options.specialistId,
      clientId: options.clientId ?? null,
      serviceId: options.serviceId ?? null,
      completedAt: options.completedAt ?? new Date(),
      plannedDurationMinutes: options.plannedDurationMinutes ?? 90,
      actualDurationMinutes: options.actualDurationMinutes ?? null,
    })
    .returning();
  return visit;
}
