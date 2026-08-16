import { and, asc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";

import { db } from "@/db";
import { memberships, organizations, pilotEnrollments, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { MemberRole } from "@/domain/rbac";
import { getPublicAppUrl, isPilotAccessEnforced } from "@/env";
import { auth } from "@/lib/auth";
import { checkRequestOrigin } from "@/lib/csrf";
import { logEvent } from "@/lib/logger";
import { readPreviewCookie } from "@/lib/preview-request";

/**
 * Who the owner really is while they look at a colleague's interface.
 *
 * Present only in preview, and it carries the *actor* — the authenticated
 * person — because the surrounding `ActiveMembership` no longer does. That is
 * the deliberate shape: every page and endpoint that filters by "own" rows
 * keeps reading `userId` and gets the previewed member without knowing preview
 * exists, and the one identity that must never be silently substituted, the
 * person accountable for the request, is the one that has to be asked for by
 * name.
 */
export type PreviewContext = Readonly<{
  actorUserId: string;
  actorEmail: string;
  targetUserId: string;
  targetEmail: string;
  targetName: string;
  targetRole: MemberRole;
}>;

export type ActiveMembership = Readonly<{
  /** The member whose rows this request may see — the previewed one, in preview. */
  userId: string;
  userEmail: string;
  organizationId: string;
  /** The role this request is evaluated against — the previewed one, in preview. */
  role: MemberRole;
  /** Set only while an owner is looking at a colleague's interface. */
  preview: PreviewContext | null;
}>;

export type CallerResult =
  | { session: false }
  | { session: true; membership: ActiveMembership | null; userId: string };

/**
 * The caller's session together with the organization they act in. Ordering is
 * explicit for the same reason the workspace page orders: without it the active
 * organization could differ between requests.
 *
 * Memoized per request (see the export below): the app shell needs the role to
 * decide which sections to draw, and the page underneath needs it again to
 * decide what to load. Without the cache that is two sessions looked up and two
 * membership joins for every navigation. `cache` is per-request, so nothing is
 * shared between users, and the CSRF refusal below is reached exactly as often
 * as it was — once, before anything else runs.
 *
 * This is the authenticated identity with no preview applied. Almost nothing
 * should want it: the endpoint that enters and leaves preview does, because it
 * has to know who is asking rather than who they are looking at, and everything
 * else wants `getActiveMembership` below.
 */
async function loadAuthenticatedMembership(): Promise<CallerResult> {
  const requestHeaders = await headers();

  // Section 7.6 applies CSRF protection to cookie-authenticated mutations. It
  // lives here rather than in each of the twenty-six handlers because this is
  // the one function all of them already call — including the multipart import
  // upload, which is the request a cross-site form can actually forge.
  if (checkRequestOrigin(requestHeaders, getPublicAppUrl()) === "refuse") {
    logEvent(
      "warn",
      "security.cross_site_refused",
      {},
      { sec_fetch_site: requestHeaders.get("sec-fetch-site") },
    );
    // The session exists; it simply does not count for a request the browser
    // says came from someone else's page. The caller answers 401 as it would
    // for any request without one.
    return { session: false };
  }

  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { session: false };

  const [row] = await db
    .select({ organizationId: memberships.organizationId, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    // Deletion removes memberships, so this join is belt and braces: a row left
    // behind by a partial failure must not grant access to a deleted workspace.
    .where(and(eq(memberships.userId, session.user.id), isNull(organizations.deletedAt)))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);

  const pilotStatus =
    row && isPilotAccessEnforced()
      ? await withTenant(row.organizationId, async (tx) => {
          const [enrollment] = await tx
            .select({ status: pilotEnrollments.status })
            .from(pilotEnrollments)
            .limit(1);
          return enrollment?.status ?? null;
        })
      : null;

  return {
    session: true,
    userId: session.user.id,
    membership:
      row &&
      (!isPilotAccessEnforced() || pilotStatus === "active")
      ? {
          userId: session.user.id,
          userEmail: session.user.email,
          organizationId: row.organizationId,
          role: row.role,
          preview: null,
        }
        : null,
  };
}

/**
 * The authenticated caller, with the owner's "посмотреть как" selection applied
 * when there is a valid one.
 *
 * Every check is made here, against the database, on every request — the cookie
 * contributes a member id and nothing else:
 *
 *   - only an owner may look, because this is an administrative affordance and
 *     nobody below owner has a reason to inspect a colleague's screen;
 *   - the target must hold a membership in the owner's own organization, which
 *     is what stops a swapped id from reaching another studio;
 *   - the target must not be an owner, which keeps the invariant that preview
 *     only ever narrows what the request may do — an owner already holds every
 *     capability, so any other role is a subset and preview cannot widen one.
 *
 * Anything unmet is not an error. The owner simply keeps their own view, which
 * is the right answer for the cases that produce it: a colleague removed from
 * the team while the tab sat open, an owner whose own access changed, a cookie
 * left behind by a different account. `components/preview-banner.tsx` clears
 * the dead cookie when it notices, so the state does not linger.
 */
async function loadActiveMembership(): Promise<CallerResult> {
  const caller = await getAuthenticatedMembership();
  if (!caller.session || !caller.membership) return caller;

  const actor = caller.membership;
  const selection = await readPreviewCookie();
  if (!selection || selection.actorUserId !== actor.userId) return caller;
  if (actor.role !== "owner" || selection.targetUserId === actor.userId) return caller;

  const [target] = await db
    .select({
      role: memberships.role,
      email: users.email,
      name: users.name,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(
      and(
        eq(memberships.userId, selection.targetUserId),
        eq(memberships.organizationId, actor.organizationId),
      ),
    )
    .limit(1);

  if (!target || target.role === "owner") return caller;

  return {
    session: true,
    userId: caller.userId,
    membership: {
      userId: selection.targetUserId,
      userEmail: target.email,
      organizationId: actor.organizationId,
      role: target.role,
      preview: {
        actorUserId: actor.userId,
        actorEmail: actor.userEmail,
        targetUserId: selection.targetUserId,
        targetEmail: target.email,
        targetName: target.name,
        targetRole: target.role,
      },
    },
  };
}

export const getAuthenticatedMembership = cache(loadAuthenticatedMembership);
export const getActiveMembership = cache(loadActiveMembership);
