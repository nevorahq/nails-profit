import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  commissionRuleServices,
  commissionRules,
  locations,
  memberships,
  scheduleRules,
  services,
  specialistLocations,
  specialists,
} from "@/db/schema";
import { db } from "@/db";
import { withTenant } from "@/db/tenant";
import { selectCommissionRule } from "@/domain/commission";
import { commissionBases, commissionTypes } from "@/domain/costing";
import { DEFAULT_WORKWEEK } from "@/domain/workspace-defaults";
import { can, canManageCatalogue, scopeFor, seesIndividualPay } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";
import { leaveSoloMode } from "@/lib/solo-mode";

/**
 * Specialists and their commission rules, spec RES-001, RES-004 and RES-005.
 *
 * Governed by the section 6.1 "Комиссии мастеров" row: Owner and Manager manage
 * them, a Master sees only their own result, an Analyst sees aggregates. Writes
 * go through canManageCatalogue, so a Master — whose scope is "own" — cannot
 * edit the rules they are paid by.
 */
const defaultRuleInput = z
  .object({
    type: z.enum(commissionTypes),
    basis_points: z.int().min(0).max(10_000).optional(),
    fixed_amount_minor: z.int().min(0).optional(),
    service_id: z.uuid().optional(),
    base: z.enum(commissionBases).optional(),
    /** Empty or absent means every service, as every earlier rule does. */
    covered_service_ids: z.array(z.uuid()).max(200).optional(),
  })
  .refine(
    (value) => {
      if (value.type === "fixed") {
        return value.fixed_amount_minor !== undefined && value.basis_points === undefined;
      }
      if (value.type === "hybrid") {
        return value.fixed_amount_minor !== undefined && value.basis_points !== undefined;
      }
      return value.basis_points !== undefined && value.fixed_amount_minor === undefined;
    },
    {
      message:
        "A fixed rule needs an amount, a percentage rule needs a rate, and a hybrid needs both",
    },
  );

const createSpecialistSchema = z.object({
  name: z.string().trim().min(1).max(200),
  cooperation_type: z.enum(["commission", "rent", "staff"]).default("commission"),
  /**
   * Who a client meets first, and who «Любой доступный» prefers.
   *
   * The column existed from the start as the tie-breaker for the public
   * assignment, and nothing could ever write it: every card kept the default
   * `0`, the tie-break fell through to comparing UUIDs, and one master
   * silently took every shared slot until somebody booked her. A studio that
   * wanted the other answer had no way to say so — see
   * `lib/public-booking-availability.ts` for what the order actually decides.
   *
   * Lower is first, the same direction and the same range as `location`'s.
   * Optional here because a studio that has never thought about the order
   * should not have to: the default keeps the cards in the order they were
   * created, which is the order they were hired in.
   */
  sort_order: z.int().min(0).max(1_000).optional(),
  // RES-005: a commission specialist needs a default rule. Optional here so the
  // record can be created first, but the costing then reports the gap rather
  // than treating the commission as zero.
  default_rule: defaultRuleInput.optional(),
  /**
   * «Это я»: the owner of a solo studio, catalogued as their own master.
   *
   * The two facts it writes are the two the product could not previously learn
   * about a solo owner. `user_id` is what every "own" scope resolves through —
   * their calendar, their visits, the notification that a client just booked
   * them — and without it the person doing the work is a name in a catalogue
   * that no account answers to. `is_principal` is what tells the month's report
   * that the commission booked to them never left the business, so it is added
   * back below the margin (see `domain/period-pl.ts`).
   *
   * Until now both could only be set afterwards, one through the team screen
   * built for invited masters and the other through a button in the list — so a
   * solo studio, which is most of the pilot, had to find two controls to say
   * one thing about itself.
   */
  is_me: z.boolean().optional(),
  /**
   * Whose account this card belongs to, given at creation.
   *
   * The link could only be made afterwards, through the team screen, and that
   * left a hole in the middle of the most ordinary sequence there is: invite a
   * master, they accept, and they appear in «Команда» and nowhere else — no
   * card in «Мастера», nothing to attach their account to. Creating the card
   * and the link together is what closes it; `is_me` is the same thing for the
   * owner themselves.
   */
  user_id: z.string().min(1).optional(),
});

export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!can(actor.role, "commissions", "read")) {
    return apiError(403, "FORBIDDEN", "This role cannot read commissions", id);
  }

  // First place `scope: "own"` becomes a real filter rather than a declaration:
  // a specialist row carries the user it belongs to, so a Master can be limited
  // to their own. Section 6.1: "Только собственный результат".
  const ownOnly = scopeFor(actor.role, "commissions") === "own";

  /*
   * And the second thing the scope alone does not say: whether this caller is
   * owed what one named person is paid. An analyst reads «Агрегаты» at scope
   * "all", so the filter above lets every row through and the rate has to be
   * withheld from the row itself. Same decision as the two screens make, taken
   * from the same function — see `seesIndividualPay`.
   */
  const withPay = seesIndividualPay(actor.role);

  const rows = await withTenant(actor.organizationId, async (tx) => {
    const people = await tx
      .select()
      .from(specialists)
      .where(
        ownOnly
          ? and(isNull(specialists.archivedAt), eq(specialists.userId, actor.userId))
          : isNull(specialists.archivedAt),
      )
      // The order the studio set, then the order they were hired in. Reading
      // by `createdAt` alone would answer a different list from the public
      // page and from «Онлайн-запись», which both order by `sortOrder` — and
      // the screen where the order is set is the last one that may disagree
      // with it.
      .orderBy(asc(specialists.sortOrder), asc(specialists.createdAt));

    return Promise.all(
      people.map(async (person) => {
        const rules = await tx
          .select({
            id: commissionRules.id,
            serviceId: commissionRules.serviceId,
            type: commissionRules.type,
            basisPoints: commissionRules.basisPoints,
            fixedAmountMinor: commissionRules.fixedAmountMinor,
            base: commissionRules.base,
            activeFrom: commissionRules.activeFrom,
            activeTo: commissionRules.activeTo,
          })
          .from(commissionRules)
          .where(eq(commissionRules.specialistId, person.id));

        const defaultRule = selectCommissionRule(
          rules.filter((rule) => rule.serviceId === null),
          "",
        );
        const exceptions = rules.filter(
          (rule) => rule.serviceId !== null && (rule.activeTo === null || rule.activeTo > new Date()),
        );

        return {
          id: person.id,
          name: person.name,
          cooperation_type: person.cooperationType,
          sort_order: person.sortOrder,
          user_id: withPay ? person.userId : null,
          is_principal: person.isPrincipal,
          default_rule:
            withPay && defaultRule
              ? {
                  type: defaultRule.type,
                  basis_points: defaultRule.basisPoints,
                  fixed_amount_minor: defaultRule.fixedAmountMinor,
                  base: defaultRule.base,
                  active_from: defaultRule.activeFrom,
                }
              : null,
          service_exceptions: withPay
            ? exceptions.map((rule) => ({
                service_id: rule.serviceId,
                type: rule.type,
                basis_points: rule.basisPoints,
                fixed_amount_minor: rule.fixedAmountMinor,
                base: rule.base,
              }))
            : [],
        };
      }),
    );
  });

  return apiSuccess(rows, id);
}

/**
 * Whether somebody is already marked as the owner who works.
 *
 * One is the limit: a principal's commission is added back below the month's
 * margin because it never left the business, and two would add back two
 * people's pay. So «это я» links the account either way and claims the mark
 * only while it is free — silently, because the person pressing it is asking to
 * be catalogued, not asking who the principal is. The mark itself is moved
 * deliberately, from the list, where taking it off one row is what frees it.
 */
async function hasPrincipal(tx: Parameters<Parameters<typeof withTenant>[1]>[0]) {
  const [existing] = await tx
    .select({ id: specialists.id })
    .from(specialists)
    .where(and(eq(specialists.isPrincipal, true), isNull(specialists.archivedAt)))
    .limit(1);
  return existing !== undefined;
}

export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const actor = caller.membership;
  if (!canManageCatalogue(actor.role, "commissions")) {
    return apiError(403, "FORBIDDEN", "This role cannot manage specialists", id);
  }

  const body = await request.json().catch(() => null);
  const parsed = createSpecialistSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  // Membership is checked outside the tenant transaction because it is the one
  // table RLS does not cover — the same check `PATCH /specialists/[id]` makes,
  // and for the same reason: an account from another organization must never
  // become someone's master here.
  if (parsed.data.user_id) {
    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, actor.organizationId),
          eq(memberships.userId, parsed.data.user_id),
        ),
      )
      .limit(1);
    if (!member) {
      return apiError(422, "USER_NOT_A_MEMBER", "This account does not belong to the organization", id);
    }
  }

  /*
   * One account, one master card. The unique index behind this refusal is
   * `specialist_org_user_idx`; catching it here says which of the two things
   * went wrong, rather than answering a bare 500 to somebody who simply
   * catalogued themselves twice.
   */
  const specialist = await withTenant(actor.organizationId, async (tx) => {
    const [created] = await tx
      .insert(specialists)
      .values({
        organizationId: actor.organizationId,
        name: parsed.data.name,
        cooperationType: parsed.data.cooperation_type,
        ...(parsed.data.sort_order !== undefined ? { sortOrder: parsed.data.sort_order } : {}),
        ...(parsed.data.is_me
          ? { userId: actor.userId, isPrincipal: !(await hasPrincipal(tx)) }
          : parsed.data.user_id
            ? { userId: parsed.data.user_id }
            : {}),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    /*
     * Where the new master works, which until now nothing wrote.
     *
     * `specialist_location` is what the public catalogue filters people by
     * (`publicSpecialistsFor`), and it was created on one screen only —
     * «Онлайн-запись», two selects deep. So a studio hired somebody, saw them
     * in the calendar and in every report, and their booking page silently went
     * on offering one master: the row that makes a person bookable did not
     * exist, and nothing anywhere said so.
     *
     * Every active address, because "which of your addresses does this person
     * work at" is a question only a studio with more than one has, and they can
     * answer it by unticking in «Онлайн-запись». For everybody else it was not
     * a choice — it was a step nobody knew about.
     */
    const places = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.status, "active"));
    if (places.length > 0) {
      await tx.insert(specialistLocations).values(
        places.map((place) => ({
          organizationId: actor.organizationId,
          specialistId: created.id,
          locationId: place.id,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })),
      );

      /*
       * And when they work, which had the same hole in the same shape.
       *
       * An address without hours in it makes nobody bookable — `bookabilityOf`
       * calls it «no_hours» and the public page offers no slot — so a studio
       * that hired somebody, gave them a rate and watched them appear in the
       * calendar still had one step left that only «Онлайн-запись» knew about,
       * two selects deep. Registration has written the same week for the people
       * it creates since it started provisioning workspaces; a person hired
       * afterwards had to be found by hand.
       *
       * Пн–Пт 08:00–16:00, the studio's own default (`DEFAULT_WORKWEEK`) and
       * the same hours registration wrote — not a guess about this person, but
       * the week the studio already said it works. From today, and closing
       * nothing: this card has no rota to hand over from. «График» on
       * «Онлайн-запись» is where it is corrected, and a PUT from the day this
       * one starts replaces it outright rather than layering on top of it.
       */
      const effectiveFrom = new Date().toISOString().slice(0, 10);
      await tx.insert(scheduleRules).values(
        places.flatMap((place) =>
          DEFAULT_WORKWEEK.weekdays.map((weekday) => ({
            organizationId: actor.organizationId,
            specialistId: created.id,
            locationId: place.id,
            weekday,
            startMinute: DEFAULT_WORKWEEK.startMinute,
            endMinute: DEFAULT_WORKWEEK.endMinute,
            effectiveFrom,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })),
        ),
      );
    }

    if (parsed.data.default_rule) {
      const [rule] = await tx
        .insert(commissionRules)
        .values({
          organizationId: actor.organizationId,
          specialistId: created.id,
          serviceId: null,
          type: parsed.data.default_rule.type,
          basisPoints: parsed.data.default_rule.basis_points ?? null,
          fixedAmountMinor: parsed.data.default_rule.fixed_amount_minor ?? null,
          base: parsed.data.default_rule.base ?? "after_discount",
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: commissionRules.id });

      // Which services the rule pays on. No rows means all of them; an unknown
      // id simply finds nothing under RLS and is dropped rather than inventing
      // coverage nobody asked for.
      const coveredIds = [...new Set(parsed.data.default_rule.covered_service_ids ?? [])];
      if (coveredIds.length > 0) {
        const known = await tx
          .select({ id: services.id })
          .from(services)
          .where(inArray(services.id, coveredIds));
        if (known.length > 0) {
          await tx.insert(commissionRuleServices).values(
            known.map((service) => ({
              organizationId: actor.organizationId,
              commissionRuleId: rule.id,
              serviceId: service.id,
              createdBy: actor.userId,
              updatedBy: actor.userId,
            })),
          );
        }
      }
    }

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "specialist.created",
      entityType: "specialist",
      entityId: created.id,
      after: {
        name: created.name,
        cooperation_type: created.cooperationType,
        sort_order: created.sortOrder,
      },
      requestId: id,
    });

    /*
     * Two masters in the catalogue is a studio, whatever the account said when
     * it was opened, and it is the catalogue rather than the invitation that
     * settles it: a small studio where the owner books everybody herself never
     * hands out a second login at all. `POST /api/v1/organizations` writes the
     * solo owner their own card, so «two» here really is one more than her.
     *
     * Counted rather than assumed from a flag: archiving a master takes the row
     * out of the count, and a studio that has shrunk back to one is still a
     * studio — `lib/solo-mode.ts` says why that is deliberate.
     */
    const live = await tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(isNull(specialists.archivedAt))
      .limit(2);
    if (live.length > 1) {
      await leaveSoloMode(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: id,
        because: "second_specialist",
      });
    }

    await recordCompletedServiceCostEvents(tx, actor);

    return created;
  }).catch((error: unknown) => {
    // One account, one master card — `specialist_org_user_idx`. Named rather
    // than answered with a 500, because «это я» pressed twice is an ordinary
    // mistake, not a fault.
    if (isUniqueViolation(error, "specialist_org_user_idx")) return "already_linked" as const;
    throw error;
  });

  if (specialist === "already_linked") {
    return apiError(
      409,
      "SPECIALIST_ALREADY_LINKED",
      "This account is already linked to a specialist",
      id,
    );
  }

  return apiSuccess(
    { id: specialist.id, name: specialist.name, sort_order: specialist.sortOrder },
    id,
    201,
  );
}
