import { eq } from "drizzle-orm";
import { z } from "zod";

import { organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can } from "@/domain/rbac";
import { isMaterialProfile } from "@/domain/material-provenance";
import { apiError, apiSuccess, requestId } from "@/lib/http";
import { loadMaterialTemplates } from "@/lib/material-templates";
import { getActiveMembership } from "@/lib/membership";
import type { AppLocale } from "@/i18n/messages";

/**
 * The curated template catalogue, epic E3.1 §3.3.
 *
 * Read-only by construction and not merely by convention: `material_template`
 * grants the application role SELECT only and carries a SELECT-only policy
 * (migration 0034), so this file having no POST is the second line of defence
 * rather than the first.
 *
 * Requires a membership even though the data is global. The catalogue is the
 * product's own research, and the locale the names come back in is the
 * organization's — there is no sensible answer for a caller who has neither.
 */
const querySchema = z.object({
  profile: z.string().optional(),
  core: z.enum(["true", "false"]).optional(),
  q: z.string().max(100).optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  if (!can(caller.membership.role, "materials", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read materials", id);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    profile: url.searchParams.get("profile") ?? undefined,
    core: url.searchParams.get("core") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The query is invalid", id);
  }

  // An unknown profile is refused rather than ignored: silently returning the
  // whole catalogue would look like the filter worked and produce a Fast Setup
  // list of 155 rows.
  const profile = parsed.data.profile;
  if (profile !== undefined && !isMaterialProfile(profile)) {
    return apiError(422, "UNKNOWN_PROFILE", "No such work profile", id);
  }

  const organizationId = caller.membership.organizationId;
  const locale = await withTenant(organizationId, async (tx) => {
    const [organization] = await tx
      .select({ locale: organizations.locale })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return organization.locale as AppLocale;
  });

  const templates = await loadMaterialTemplates(locale, {
    profile,
    coreOnly: parsed.data.core === "true",
    search: parsed.data.q,
  });

  return apiSuccess(templates, id);
}
