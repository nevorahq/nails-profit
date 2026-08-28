import { asc, eq, inArray, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { currencies } from "@/domain/money";
import { SLUG_MAX_LENGTH, slugCandidatesFor } from "@/domain/slug";
import { auth } from "@/lib/auth";
import {
  isLatinOrganizationName,
  ORGANIZATION_NAME_MESSAGE,
} from "@/domain/organization-name";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";

const createOrganizationSchema = z.object({
  // Latin script, the same rule the workspace form states under its own field
  // — see `domain/organization-name.ts` for why it is a naming decision rather
  // than a limit of the slug.
  name: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .refine(isLatinOrganizationName, { message: ORGANIZATION_NAME_MESSAGE }),
  type: z.enum(["solo", "studio"]),
  currency: z.enum(currencies).default("MDL"),
  locale: z.enum(["ru", "ro", "en"]).default("ru"),
});

async function currentUser() {
  return auth.api.getSession({ headers: await headers() });
}

export async function GET(request: Request) {
  const id = requestId(request);
  const session = await currentUser();
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      type: organizations.type,
      currency: organizations.currency,
      locale: organizations.locale,
      timezone: organizations.timezone,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, session.user.id))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));

  return apiSuccess(rows, id);
}

export async function POST(request: Request) {
  const id = requestId(request);
  const session = await currentUser();
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const body = await request.json().catch(() => null);
  const parsed = createOrganizationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const createOrganization = () =>
    db.transaction(async (tx) => {
      // A client that goes away mid-transaction must not hold the lock below
      // forever — see the comment on the same guard in `db/tenant.ts`.
      await tx.execute(sql`select set_config('idle_in_transaction_session_timeout', '30000', true)`);
      // "One organization per user" is an MVP product policy, not a domain
      // invariant — Studio orgs will need several memberships per user later, so
      // this is serialized with a lock rather than frozen into a unique index.
      // Without it, concurrent requests each see an empty membership set and
      // every one of them creates an organization.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.user.id}, 0))`);

      const existing = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, session.user.id))
        .limit(1);
      if (existing.length > 0) return null;

      /*
       * The public address, given rather than asked for.
       *
       * `/book/<slug>` is how a client reaches this studio, and the studio used
       * to have to invent it on a settings screen it had no reason to open —
       * until then the booking page it had published simply did not exist at any
       * address. The name typed one field above is the answer, and `slugify` has
       * always been able to transliterate it.
       *
       * The taken ones are read here rather than the insert being allowed to fail
       * on the unique index: two studios called «Ногти» is an ordinary Tuesday,
       * and the second one must be registered, not refused for a reason it cannot
       * see. `organization` is the one table whose RLS policy is `true`, so this
       * reads across tenants on purpose — an address is unique to the whole
       * application, not to a tenant.
       */
      const candidates = slugCandidatesFor(parsed.data.name);
      const taken = new Set(
        (
          await tx
            .select({ slug: organizations.slug })
            .from(organizations)
            .where(inArray(organizations.slug, candidates))
        ).map((row) => row.slug),
      );
      /*
     * A tail of random hex only if twenty-five studios of this name already
     * exist, which is not a case worth a prettier answer — but leaving the
     * column null is: there is no screen any more on which an address could be
     * typed, so a studio that fell through here would have no public page and
     * no way to ask for one.
     */
    const slug =
      candidates.find((candidate) => !taken.has(candidate)) ??
      `${candidates[0].slice(0, SLUG_MAX_LENGTH - 9)}-${crypto.randomUUID().slice(0, 8)}`;

      const [created] = await tx
        .insert(organizations)
        .values({
          ...parsed.data,
          slug,
          timezone: "Europe/Chisinau",
          createdBy: session.user.id,
          updatedBy: session.user.id,
        })
        .returning();

      await tx.insert(memberships).values({
        organizationId: created.id,
        userId: session.user.id,
        role: "owner",
        createdBy: session.user.id,
        updatedBy: session.user.id,
      });

      // Pilot telemetry is tenant-protected, so establish the tenant only after
      // the organization and its first membership exist in this transaction.
      await tx.execute(sql`select set_config('app.current_organization_id', ${created.id}::text, true)`);
      await recordPilotProductEvent(tx, {
        organizationId: created.id,
        eventName: "onboarding_started",
        actorUserId: session.user.id,
        actorRole: "owner",
        source: "api",
        entityType: "organization",
        entityId: created.id,
      });
      return created;
    });

  /*
   * One retry, for the one thing the reads above cannot rule out: two studios
   * of the same name registering in the same instant, both finding the same
   * address free. The index is what actually decides, and the loser recomputes
   * against a set that now contains the winner's. Anything else is rethrown —
   * a failed registration must not be retried into a second organization.
   */
  let organization: Awaited<ReturnType<typeof createOrganization>> = null;
  for (let attempt = 0; ; attempt++) {
    try {
      organization = await createOrganization();
      break;
    } catch (error) {
      if (attempt < 2 && isUniqueViolation(error, "organization_slug_idx")) continue;
      throw error;
    }
  }

  if (!organization) {
    return apiError(409, "MEMBERSHIP_EXISTS", "User already belongs to an organization", id);
  }

  return apiSuccess(organization, id, 201);
}
