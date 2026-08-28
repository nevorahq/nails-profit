import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { commissionRuleServices, commissionRules, memberships, services, specialists } from "@/db/schema";
import { db } from "@/db";
import { withTenant } from "@/db/tenant";
import { selectCommissionRule } from "@/domain/commission";
import { commissionBases, commissionTypes } from "@/domain/costing";
import { can, canManageCatalogue, scopeFor } from "@/domain/rbac";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import { recordCompletedServiceCostEvents } from "@/lib/pilot-events";

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

  const rows = await withTenant(actor.organizationId, async (tx) => {
    const people = await tx
      .select()
      .from(specialists)
      .where(
        ownOnly
          ? and(isNull(specialists.archivedAt), eq(specialists.userId, actor.userId))
          : isNull(specialists.archivedAt),
      )
      .orderBy(asc(specialists.createdAt));

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
          user_id: person.userId,
          is_principal: person.isPrincipal,
          default_rule: defaultRule
            ? {
                type: defaultRule.type,
                basis_points: defaultRule.basisPoints,
                fixed_amount_minor: defaultRule.fixedAmountMinor,
                base: defaultRule.base,
                active_from: defaultRule.activeFrom,
              }
            : null,
          service_exceptions: exceptions.map((rule) => ({
            service_id: rule.serviceId,
            type: rule.type,
            basis_points: rule.basisPoints,
            fixed_amount_minor: rule.fixedAmountMinor,
            base: rule.base,
          })),
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
        ...(parsed.data.is_me
          ? { userId: actor.userId, isPrincipal: !(await hasPrincipal(tx)) }
          : parsed.data.user_id
            ? { userId: parsed.data.user_id }
            : {}),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

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
      after: { name: created.name, cooperation_type: created.cooperationType },
      requestId: id,
    });

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

  return apiSuccess({ id: specialist.id, name: specialist.name }, id, 201);
}
