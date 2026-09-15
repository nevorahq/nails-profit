import { cache } from "react";
import { eq } from "drizzle-orm";

import { organizationLogos } from "@/db/schema";
import { withTenant } from "@/db/tenant";

/**
 * The version of the studio's mark, or null when it has none.
 *
 * Only the version, because that is all a page needs: it decides whether the
 * topbar draws the flower or an `<img>`, and it is the cache key in that image's
 * URL. The bytes stay in the database until the browser asks
 * `GET /api/v1/organizations/logo` for them.
 *
 * Memoized per request, so the layout drawing the topbar and the settings page
 * drawing its preview read the row once between them rather than once each.
 *
 * `withTenant` rather than a plain read, because `organization_logo` is behind
 * the tenant policy: a query without `app.current_organization_id` set finds
 * nothing at all, which would look exactly like a studio that has no logo.
 */
export const loadOrganizationLogoVersion = cache(
  async (organizationId: string): Promise<number | null> => {
    const [row] = await withTenant(organizationId, (tx) =>
      tx
        .select({ version: organizationLogos.version })
        .from(organizationLogos)
        .where(eq(organizationLogos.organizationId, organizationId))
        .limit(1),
    );
    return row?.version ?? null;
  },
);
