import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";

import { organizations, paymentMethods, taxRules } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import type { RuleChangeRefusal } from "@/domain/rule-change";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { recordAuditEvent } from "@/lib/audit";
import { createTaxRule } from "@/lib/tax-rules";

/**
 * The two questions a studio's profit is silently wrong without.
 *
 * Every figure the report draws is before whatever the state and the bank take
 * from a visit, unless the studio has said what those are. A studio that never
 * said reads a profit larger than the one it banks, and nothing on the screen
 * tells it so. So the answer is asked for — on the month's guide and on «Деньги»
 * — and until it is given the report says what its profit is before.
 *
 * Measured, like every step in `lib/onboarding.ts`: a question is answered by
 * a rule that exists, or by the stored moment somebody said «не плачу» /
 * «только наличные». The rule counts even once it has ended or been archived —
 * somebody looked at the question and chose — and it counts whether or not
 * the stored moment was ever written, so a rule entered by a build that did not
 * know about the question still answers it.
 */
export type MoneyAnswers = Readonly<{ taxes: boolean; payments: boolean }>;

/** The tax kinds a visit's price is taxed by. Payroll contributions are another question. */
const visitTaxKinds = ["vat", "turnover"] as const;

export async function loadMoneyAnswers(tx: TenantTransaction, organizationId: string): Promise<MoneyAnswers> {
  const [row] = await tx
    .select({
      taxes: sql<boolean>`${organizations.taxesAnsweredAt} is not null or ${exists(
        tx
          .select({ one: sql`1` })
          .from(taxRules)
          .where(inArray(taxRules.kind, [...visitTaxKinds])),
      )}`,
      payments: sql<boolean>`${organizations.paymentsAnsweredAt} is not null or ${exists(
        tx.select({ one: sql`1` }).from(paymentMethods),
      )}`,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return { taxes: row?.taxes ?? false, payments: row?.payments ?? false };
}

/** Whether the report still has to say its profit is before taxes and the bank's fee. */
export function profitBeforeTaxes(answers: MoneyAnswers): boolean {
  return !answers.taxes || !answers.payments;
}

/** Where the first unanswered question is asked, for a link that says «указать». */
export function firstUnansweredHref(answers: MoneyAnswers): string | null {
  if (!answers.taxes) return "/app/expenses#taxes";
  if (!answers.payments) return "/app/expenses#payments";
  return null;
}

type Actor = Readonly<{ organizationId: string; userId: string }>;

export type TaxesAnswer =
  | Readonly<{ answer: "none" }>
  | Readonly<{ answer: "turnover" | "vat"; basisPoints: number }>;

export type AnswerRefusal = "already_answered" | RuleChangeRefusal;

/**
 * «Как вы платите налоги?», answered once.
 *
 * A rate is written as the same rule «Налоги с визита» writes, through the same
 * function. A second answer is refused rather than applied: an answered
 * question is changed where its rules live, and «не плачу» arriving over a live
 * VAT rate would leave the two contradicting each other with nothing to say
 * which one the owner meant.
 */
export async function answerTaxes(
  tx: TenantTransaction,
  actor: Actor,
  input: TaxesAnswer,
  requestId: string,
): Promise<{ ok: true } | { ok: false; reason: AnswerRefusal }> {
  await lockOrganization(tx, actor.organizationId);
  const answers = await loadMoneyAnswers(tx, actor.organizationId);
  if (answers.taxes) return { ok: false, reason: "already_answered" };

  if (input.answer !== "none") {
    const created = await createTaxRule(tx, actor, { kind: input.answer, basisPoints: input.basisPoints }, requestId);
    if (!created.ok) return created;
  }

  const answeredAt = new Date();
  await tx
    .update(organizations)
    .set({ taxesAnsweredAt: answeredAt, updatedBy: actor.userId, updatedAt: answeredAt })
    .where(eq(organizations.id, actor.organizationId));

  await recordAuditEvent(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    eventType: "organization.taxes_answered",
    entityType: "organization",
    entityId: actor.organizationId,
    after: { answer: input.answer, ...(input.answer === "none" ? {} : { basis_points: input.basisPoints }) },
    requestId,
  });

  return { ok: true };
}

export type PaymentKind = "cash" | "card" | "transfer";

export type PaymentsAnswer = Readonly<{
  methods: readonly PaymentKind[];
  /** What the bank takes on a card payment; asked only when card is among `methods`. */
  cardBasisPoints: number | null;
  /** The most frequent of `methods`, which the closing form starts on. */
  defaultKind: PaymentKind;
}>;

/**
 * «Как платят клиенты?», answered once — as payment methods, the same rows
 * «Способы оплаты» keeps, named in the studio's language.
 *
 * «Только наличные» is an answer like any other: it writes one cash method,
 * which is what tells the closing form there is nothing to choose and the
 * report that nothing is owed to a bank.
 */
export async function answerPayments(
  tx: TenantTransaction,
  actor: Actor,
  input: PaymentsAnswer,
  requestId: string,
): Promise<{ ok: true } | { ok: false; reason: "already_answered" }> {
  const [organization] = await lockOrganization(tx, actor.organizationId);
  const answers = await loadMoneyAnswers(tx, actor.organizationId);
  if (answers.payments) return { ok: false, reason: "already_answered" };

  const t = getTranslator(organization.locale as AppLocale);

  // Cleared first, for the same reason `POST /api/v1/payment-methods` does:
  // the partial unique index allows one live default.
  await tx
    .update(paymentMethods)
    .set({ isDefault: false, updatedBy: actor.userId, updatedAt: new Date() })
    .where(and(eq(paymentMethods.isDefault, true), isNull(paymentMethods.archivedAt)));

  const rows = await tx
    .insert(paymentMethods)
    .values(
      input.methods.map((kind) => ({
        organizationId: actor.organizationId,
        name: t(`payment.kind.${kind}`),
        kind,
        commissionBasisPoints: kind === "card" ? (input.cardBasisPoints ?? 0) : 0,
        isDefault: kind === input.defaultKind,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })),
    )
    .returning();

  const answeredAt = new Date();
  await tx
    .update(organizations)
    .set({ paymentsAnsweredAt: answeredAt, updatedBy: actor.userId, updatedAt: answeredAt })
    .where(eq(organizations.id, actor.organizationId));

  for (const row of rows) {
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "payment_method.created",
      entityType: "payment_method",
      entityId: row.id,
      after: {
        name: row.name,
        kind: row.kind,
        commission_basis_points: row.commissionBasisPoints,
        fixed_fee_minor: row.fixedFeeMinor,
        is_default: row.isDefault,
      },
      requestId,
    });
  }

  return { ok: true };
}

/**
 * The organization row, held for the rest of the transaction, so that two
 * answers sent at once cannot both find the question open.
 */
function lockOrganization(tx: TenantTransaction, organizationId: string) {
  return tx
    .select({ locale: organizations.locale })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
}
