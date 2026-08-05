import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizations } from "@/db/schema";
import { getActiveMembership, type ActiveMembership } from "@/lib/membership";
import type { AppLocale } from "@/i18n/messages";

export type Workspace = Readonly<{
  membership: ActiveMembership;
  organizationName: string;
  locale: AppLocale;
  currency: string;
}>;

/**
 * Server-side guard for the /app pages. Redirects rather than rendering an
 * error: a signed-out visitor belongs on the login page, and someone with no
 * organization belongs in the setup flow.
 */
export async function requireWorkspace(): Promise<Workspace> {
  const caller = await getActiveMembership();
  if (!caller.session) redirect("/login");
  if (!caller.membership) redirect("/app");

  const [organization] = await db
    .select({ name: organizations.name, locale: organizations.locale, currency: organizations.currency })
    .from(organizations)
    .where(eq(organizations.id, caller.membership.organizationId))
    .limit(1);

  return {
    membership: caller.membership,
    organizationName: organization?.name ?? "",
    locale: (organization?.locale ?? "ru") as AppLocale,
    currency: organization?.currency ?? "MDL",
  };
}
