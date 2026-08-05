import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { auth } from "@/lib/auth";
import type { AppLocale } from "@/i18n/messages";
import { localeFromHeader } from "@/i18n/accept-language";

/**
 * Which language the interface renders in, spec LOC-008.
 *
 * The organization's own setting wins — a Chișinău studio that works in
 * Romanian should not have its interface flip because a master's laptop is
 * configured in English. `Accept-Language` is only the fallback for visitors
 * who have no organization yet: the landing and login pages, where guessing
 * from the browser is the only signal there is.
 */
export async function resolveLocale(): Promise<AppLocale> {
  const session = await auth.api.getSession({ headers: await headers() });

  if (session) {
    const [row] = await db
      .select({ locale: organizations.locale })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, session.user.id))
      .limit(1);
    if (row) return row.locale as AppLocale;
  }

  return localeFromHeader((await headers()).get("accept-language"));
}
