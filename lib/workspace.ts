import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";

import { db } from "@/db";
import { organizations } from "@/db/schema";
import { getActiveMembership, type ActiveMembership } from "@/lib/membership";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";

export type Workspace = Readonly<{
  membership: ActiveMembership;
  organizationName: string;
  organizationSlug: string | null;
  /** How far the booking module is rolled out here, roadmap section 7.11. */
  bookingAccess: "off" | "calendar" | "public";
  locale: AppLocale;
  currency: string;
  /**
   * Studio or someone working alone. Chooses wording and nothing else: every
   * figure is computed the same way for both, so switching it recomputes no
   * history — see `i18n/business-labels.ts`.
   */
  businessType: BusinessType;
  /**
   * The share of rostered hours the studio expects to sell, in basis points.
   * Read here because it is settings-shaped rather than report-shaped: the
   * control that changes it lives on the settings page, and every figure
   * computed from it is built in `domain/capacity.ts`.
   */
  practicalCapacityBasisPoints: number;
}>;

/**
 * Server-side guard for the /app pages. Redirects rather than rendering an
 * error: a signed-out visitor belongs on the login page, and someone with no
 * organization belongs in the setup flow.
 *
 * Memoized per request alongside `getActiveMembership`, because the shell and
 * the page it wraps both need the organization's name and locale.
 */
async function loadWorkspace(): Promise<Workspace> {
  const caller = await getActiveMembership();
  if (!caller.session) redirect("/login");
  if (!caller.membership) redirect("/app");

  const [organization] = await db
    .select({
      name: organizations.name,
      slug: organizations.slug,
      bookingAccess: organizations.bookingAccess,
      locale: organizations.locale,
      currency: organizations.currency,
      type: organizations.type,
      practicalCapacityBasisPoints: organizations.practicalCapacityBasisPoints,
    })
    .from(organizations)
    .where(eq(organizations.id, caller.membership.organizationId))
    .limit(1);

  return {
    membership: caller.membership,
    organizationName: organization?.name ?? "",
    organizationSlug: organization?.slug ?? null,
    bookingAccess: organization?.bookingAccess ?? "calendar",
    locale: (organization?.locale ?? "ru") as AppLocale,
    currency: organization?.currency ?? "MDL",
    businessType: organization?.type ?? "solo",
    practicalCapacityBasisPoints: organization?.practicalCapacityBasisPoints ?? 7500,
  };
}

export const requireWorkspace = cache(loadWorkspace);
