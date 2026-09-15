import { asc, eq, inArray, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { currencies } from "@/domain/money";
import { SLUG_MAX_LENGTH, slugCandidatesFor } from "@/domain/slug";
import { catalogueEntry } from "@/domain/service-catalogue";
import { isSupportedTimezone, parseLocalTime } from "@/domain/timezone";
import { auth } from "@/lib/auth";
import {
  isLatinOrganizationName,
  latinizeOrganizationName,
  ORGANIZATION_NAME_MESSAGE,
} from "@/domain/organization-name";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { recordPilotProductEvent } from "@/lib/pilot-events";
import { announceStudioLead } from "@/lib/studio-lead-notice";
import { provisionWorkspace, type WorkspacePlan } from "@/lib/workspace-provisioning";

/**
 * A service the setup screen ticked, priced by the owner.
 *
 * A catalogue key rather than a name: the three languages of it are in
 * `domain/service-catalogue.ts`, and a request that carried its own name could
 * only carry one of them.
 */
const setupServiceSchema = z.object({
  key: z.string().trim().min(1).max(40),
  price_minor: z.int().min(0),
  duration_minutes: z.int().positive().max(24 * 60),
});

const setupWorkweekSchema = z.object({
  weekdays: z.array(z.int().min(1).max(7)).min(1).max(7),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

/**
 * Everything the workspace form asks, which is everything the product used to
 * ask afterwards.
 *
 * Only `name` and `type` are required, and that is on purpose: this endpoint is
 * older than the setup screen and is called by a dozen tests and fixtures with
 * the four original fields. Every addition below is optional, so a request that
 * knows nothing about them creates exactly the workspace it created before.
 */
const createOrganizationSchema = z.object({
  /**
   * Latin script — see `domain/organization-name.ts` for why it is a naming
   * decision rather than a limit of the slug.
   *
   * Optional, because the setup form stopped asking: an account has just been
   * created under somebody's own name, and typing «Irina Popescu» a second time
   * two minutes later is a question the product can answer for itself. A
   * request that sends nothing is named after the account below; one that sends
   * a name is still held to the rule, since this endpoint and the settings one
   * are reachable without a browser.
   */
  name: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .refine(isLatinOrganizationName, { message: ORGANIZATION_NAME_MESSAGE })
    .optional(),
  type: z.enum(["solo", "studio"]),
  currency: z.enum(currencies).default("MDL"),
  locale: z.enum(["ru", "ro", "en"]).default("ru"),
  address: z.string().trim().max(300).optional(),
  /** The registering browser's own zone; the studio's hours are read in it. */
  timezone: z.string().trim().max(64).optional(),
  /** The default rate every card created here is paid by. 4000 = 40%. */
  commission_basis_points: z.int().min(0).max(10_000).optional(),
  /**
   * Whether the owner takes clients themselves.
   *
   * Absent means «as the format says», which is what every caller written
   * before this field sends: a solo workspace is somebody working alone, a
   * studio is not asked. The setup form asks outright, so a studio whose owner
   * stands at a table is finally describable.
   */
  owner_works: z.boolean().optional(),
  /**
   * What to call the owner's own card, when it is not the studio's own name.
   *
   * Sign-up asks for the studio, so the account carries «Studio Belle» — right
   * for a solo workspace, where the studio is the person, and wrong for a
   * studio of three, where a client would be offered «Studio Belle» standing
   * beside «Ana» and «Maria».
   */
  owner_name: z.string().trim().min(2).max(200).optional(),
  /**
   * Whether the studio's public booking page goes live with the workspace.
   *
   * Two rows say so — `booking_access` here and `public_status` on the
   * address's settings — and until both do, `/book/<slug>` is a 404 the owner
   * has to go and fix in a screen they have no reason to open.
   */
  publish_booking: z.boolean().optional(),
  /** Other people who work here, named on the form. */
  masters: z.array(z.string().trim().min(2).max(200)).max(20).optional(),
  services: z.array(setupServiceSchema).max(20).optional(),
  workweek: setupWorkweekSchema.optional(),
  rent_minor: z.int().min(0).optional(),
});

type CreateOrganizationBody = z.infer<typeof createOrganizationSchema>;

/**
 * The half of the request zod cannot judge on shape alone, turned into the plan
 * `provisionWorkspace` writes — or into the fields that were wrong.
 *
 * Checked here rather than inside the transaction because a refusal has to be
 * something the owner can fix on the form: once the transaction has begun, the
 * only honest answer to a bad interval is to roll the whole registration back,
 * and the second attempt is met with MEMBERSHIP_EXISTS.
 */
function planFor(
  body: CreateOrganizationBody,
): { plan: WorkspacePlan } | { fieldErrors: { field: string; code: string; message: string }[] } {
  const fieldErrors: { field: string; code: string; message: string }[] = [];

  if (body.timezone !== undefined && !isSupportedTimezone(body.timezone)) {
    fieldErrors.push({ field: "timezone", code: "unknown", message: "Unknown IANA timezone" });
  }

  for (const [index, service] of (body.services ?? []).entries()) {
    if (!catalogueEntry(service.key)) {
      fieldErrors.push({
        field: `services.${index}.key`,
        code: "unknown",
        message: "Not a service kind the catalogue knows",
      });
    }
  }

  let workweek: WorkspacePlan["workweek"];
  if (body.workweek) {
    const startMinute = parseLocalTime(body.workweek.start);
    // 24:00 is a legal end and nothing else is — the same rule the rota
    // endpoint applies, so a week saved here and a week saved there cannot
    // disagree about midnight.
    const endMinute = body.workweek.end === "24:00" ? 24 * 60 : parseLocalTime(body.workweek.end);
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      fieldErrors.push({
        field: "workweek",
        code: "invalid_interval",
        message: "An interval must start before it ends",
      });
    } else {
      workweek = {
        // Deduplicated, because the check constraint would not notice a day
        // sent twice and the calendar would show the shift twice.
        weekdays: [...new Set(body.workweek.weekdays)],
        startMinute,
        endMinute,
      };
    }
  }

  if (fieldErrors.length > 0) return { fieldErrors };

  return {
    plan: {
      address: body.address,
      ownerWorks: body.owner_works ?? body.type === "solo",
      ownerName: body.owner_name,
      publishBooking: body.publish_booking,
      timezone: body.timezone,
      commissionBasisPoints: body.commission_basis_points,
      masters: body.masters,
      services: (body.services ?? []).map((service) => ({
        key: service.key,
        priceMinor: service.price_minor,
        durationMinutes: service.duration_minutes,
      })),
      workweek,
      rentMinor: body.rent_minor,
    },
  };
}

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

  /*
   * What the studio is called when the form did not ask.
   *
   * The account's own name, latinised — «Ирина Попеску» becomes «Irina
   * Popesku», which is what a client reads on the booking link. Then the local
   * part of the address, for an account named in a script the table does not
   * know; then a word, because a studio must have a name and none of the three
   * steps above can be allowed to fail a registration. Every one of them is
   * editable in Настройки the minute the owner disagrees.
   */
  const name =
    parsed.data.name ??
    latinizeOrganizationName(session.user.name ?? "") ??
    latinizeOrganizationName(session.user.email.split("@")[0]) ??
    "Studio";

  const planned = planFor(parsed.data);
  if ("fieldErrors" in planned) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: planned.fieldErrors,
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
      const candidates = slugCandidatesFor(name);
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
          name,
          type: parsed.data.type,
          currency: parsed.data.currency,
          locale: parsed.data.locale,
          slug,
          /*
           * The zone the studio's hours are read in, taken from the browser
           * that registered rather than assumed.
           *
           * It was `Europe/Chisinau` for everybody, which is right for the
           * pilot and quietly wrong for the first studio outside it: the rota
           * would be written in one zone and the working day read in another,
           * and nothing on any screen would say so. The setup form sends
           * `Intl.DateTimeFormat().resolvedOptions().timeZone`; a request
           * without one keeps the pilot's zone, which is what every existing
           * caller of this endpoint sends.
           */
          timezone: parsed.data.timezone ?? "Europe/Chisinau",
          // The public half of «принимать записи онлайн»; the address's own
          // settings are written beside it in `provisionWorkspace`.
          ...(planned.plan.publishBooking ? { bookingAccess: "public" as const } : {}),
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

      // Pilot telemetry and the specialist card below are both tenant-protected,
      // so establish the tenant only after the organization and its first
      // membership exist in this transaction.
      await tx.execute(sql`select set_config('app.current_organization_id', ${created.id}::text, true)`);

      /*
       * Somebody working alone, catalogued as the master they are.
       *
       * The first thing a solo studio used to be asked for was «Добавьте
       * мастера»: a woman who works by herself, greeted by a form for hiring
       * somebody who does not exist. Every fact that form collected is already
       * known here — the name is on the account, the account is the one signing
       * up, and in a studio of one the master and the owner are the same
       * person. So the card is written rather than requested, and «Первый
       * расчёт» starts at the one thing nobody else can answer: what that work
       * is worth.
       *
       * `isPrincipal` is the half that cannot be recovered later by guessing.
       * It is what tells the monthly report that the commission booked here
       * never left the business (`domain/period-pl.ts`), and it used to depend
       * on a tickbox the owner could quietly clear — see
       * `domain/principal.ts` for what noticed afterwards.
       *
       * Not done for a studio: which of its masters is the owner, or whether
       * the owner stands at a table at all, is exactly what `organization.type`
       * cannot answer (`db/schema.ts` says so on the column itself).
       */
      /*
       * The people, the address, the rate, the catalogue, the week and the rent
       * — whatever of them the form was given, written here rather than asked
       * for again one screen at a time. `lib/workspace-provisioning.ts` says
       * why they belong in this transaction and not in five later ones.
       */
      await provisionWorkspace(tx, {
        organization: {
          id: created.id,
          name: created.name,
          currency: created.currency,
          locale: created.locale,
          timezone: created.timezone,
        },
        actor: { userId: session.user.id },
        plan: planned.plan,
      });

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

  /*
   * The studio is registered; now somebody is told about it.
   *
   * Awaited rather than left running after the response, because a serverless
   * instance is free to freeze the moment it answers and a promise nobody holds
   * is a letter that arrives only sometimes. It costs one provider round trip on
   * the single request in a studio's life that creates it — and it cannot fail
   * the registration: `announceStudioLead` resolves whatever happens.
   */
  await announceStudioLead(
    {
      organizationId: organization.id,
      organizationName: organization.name,
      slug: organization.slug,
      type: organization.type,
      currency: organization.currency,
      locale: organization.locale,
      ownerName: session.user.name,
      ownerEmail: session.user.email,
    },
    id,
  );

  return apiSuccess(organization, id, 201);
}
