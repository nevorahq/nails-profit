import type { MemberRole } from "@/domain/rbac";
import { dataOf, signUp, type Actor } from "./api";

/**
 * The canonical studio from Gate 2 and spec section 17.1, built the way an
 * owner builds it: sign up, create the organization, add a master with a 40%
 * commission, a material at 100 MDL per 10 ml, a service at 600 MDL for 90
 * minutes, and a recipe using 3.5 ml — 35 MDL of material.
 *
 * Shared by the scenarios that need a working studio, so the numbers everything
 * is checked against are written down once.
 */
export const CANONICAL = {
  servicePriceMinor: 60_000,
  serviceDurationMinutes: 90,
  commissionBasisPoints: 4_000,
  packagePriceMinor: 10_000,
  packageSize: 10,
  recipeQuantity: 3.5,
  /** What the six figures above must produce. */
  materialCostMinor: 3_500,
  commissionMinor: 24_000,
  contributionMarginMinor: 32_500,
  marginBasisPoints: 5_417,
  profitPerHourMinor: 21_667,
} as const;

export type Studio = Readonly<{
  owner: Actor;
  organizationId: string;
  specialistId: string;
  materialId: string;
  serviceId: string;
}>;

export async function createCanonicalStudio(email: string, organizationName = "Canonical Studio"): Promise<Studio> {
  const owner = await signUp(email);

  const organizationId = dataOf<{ id: string }>(
    await owner.post("/api/v1/organizations", {
      name: organizationName,
      type: "solo",
      currency: "MDL",
      locale: "ru",
    }),
  ).id;

  const specialistId = dataOf<{ id: string }>(
    await owner.post("/api/v1/specialists", {
      name: "Мастер",
      default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
    }),
  ).id;

  const materialId = dataOf<{ id: string }>(
    await owner.post("/api/v1/materials", {
      name: "База",
      base_unit: "ml",
      package_price_minor: CANONICAL.packagePriceMinor,
      package_size: CANONICAL.packageSize,
    }),
  ).id;

  const serviceId = dataOf<{ id: string }>(
    await owner.post("/api/v1/services", {
      name: { ru: "Маникюр с покрытием" },
      price_minor: CANONICAL.servicePriceMinor,
      duration_minutes: CANONICAL.serviceDurationMinutes,
    }),
  ).id;

  await owner.put(`/api/v1/services/${serviceId}/recipe`, {
    items: [{ material_id: materialId, quantity: CANONICAL.recipeQuantity }],
  });

  return { owner, organizationId, specialistId, materialId, serviceId };
}

/**
 * A colleague, added the only way the product allows: an invitation issued by
 * someone who may grant that role, then accepted by an account with the same
 * address. There is no back door for tests — the membership under test is one
 * the product can actually produce.
 */
export async function inviteMember(owner: Actor, email: string, role: MemberRole): Promise<Actor> {
  const { token } = dataOf<{ token: string }>(await owner.post("/api/v1/invitations", { email, role }));
  const member = await signUp(email, role);
  await member.post("/api/v1/invitations/accept", { token });
  return member;
}
