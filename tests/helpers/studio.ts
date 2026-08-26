import type { MemberRole } from "@/domain/rbac";
import { dataOf, signUp, type Actor } from "./api";

/**
 * The canonical studio from Gate 2 and spec section 17.1, built the way an
 * owner builds it: sign up, create the organization, add a master with a 40%
 * commission, and a service at 600 MDL for 90 minutes.
 *
 * Shared by the scenarios that need a working studio, so the numbers everything
 * is checked against are written down once. They moved when the material engine
 * was removed: the same visit now keeps the 35 MDL of material it used to
 * subtract, so the margin is higher and the two figures derived from it follow.
 */
export const CANONICAL = {
  servicePriceMinor: 60_000,
  serviceDurationMinutes: 90,
  commissionBasisPoints: 4_000,
  /** What the three figures above must produce. */
  commissionMinor: 24_000,
  contributionMarginMinor: 36_000,
  marginBasisPoints: 6_000,
  profitPerHourMinor: 24_000,
} as const;

export type Studio = Readonly<{
  owner: Actor;
  organizationId: string;
  specialistId: string;
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

  const serviceId = dataOf<{ id: string }>(
    await owner.post("/api/v1/services", {
      name: { ru: "Маникюр с покрытием" },
      price_minor: CANONICAL.servicePriceMinor,
      duration_minutes: CANONICAL.serviceDurationMinutes,
    }),
  ).id;

  return { owner, organizationId, specialistId, serviceId };
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
