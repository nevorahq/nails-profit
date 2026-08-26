import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  clients,
  commissionRules,
  externalReferences,
  services,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import type { Currency } from "@/domain/money";
import { normalizeKeyPart } from "@/domain/import-identity";
import type { CellValue, MappedRow, RowIssue } from "@/domain/import-mapping";
import type { ImportableEntity } from "@/domain/import-templates";
import { findPostgresError } from "@/lib/db-errors";
import type { AppLocale } from "@/i18n/messages";

/**
 * Writing an accepted preview into the catalogue, spec INT-004 and INT-005.
 *
 * The requirement that shapes everything here is that importing the same file
 * twice must not double anything. That needs three lookups in order, because
 * each covers a case the others miss:
 *
 *  1. the external reference, which is the record of "we have imported this row
 *     before" and is the only one that survives a rename;
 *  2. the natural key among existing rows, which catches the service the owner
 *     already typed by hand before they ever imported a price list — without
 *     it, the first import duplicates everything they had;
 *  3. otherwise create.
 */

export const IMPORT_PROVIDER = "csv";

export type ImportOutcome = Readonly<{
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  issues: readonly RowIssue[];
}>;

type ApplyContext = Readonly<{
  tx: TenantTransaction;
  organizationId: string;
  actorUserId: string;
  currency: Currency;
  locale: AppLocale;
}>;

type RowResult = "created" | "updated" | "skipped";

export async function applyImport(
  context: ApplyContext,
  entity: ImportableEntity,
  rows: readonly MappedRow[],
): Promise<ImportOutcome> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const issues: RowIssue[] = [];

  for (const row of rows) {
    try {
      // A savepoint per row, so INT-005's "ошибки строк не отменяют валидные
      // строки" holds against the database too and not only against validation.
      // Without it one constraint violation on row 200 discards the 199 rows
      // already written, and the owner is told to fix a file that was almost
      // entirely fine.
      const outcome = await context.tx.transaction((nested) =>
        applyRow({ ...context, tx: nested }, entity, row),
      );
      if (outcome === "created") created += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      issues.push({
        line: row.line,
        field: "",
        code: "write_failed",
        value: describeWriteFailure(error),
      });
    }
  }

  return { created, updated, skipped, failed, issues };
}

/**
 * A short reason for the result screen. Constraint names are more useful than
 * driver prose here — `client_org_phone_idx` tells the owner two rows share a
 * phone number, which is something they can act on in the file.
 */
function describeWriteFailure(error: unknown): string {
  const postgres = findPostgresError(error);
  if (postgres?.constraint_name) return postgres.constraint_name;
  return error instanceof Error ? error.message : "unknown error";
}

async function applyRow(
  context: ApplyContext,
  entity: ImportableEntity,
  row: MappedRow,
): Promise<RowResult> {
  const linked = await findByReference(context, entity, row.externalId);

  switch (entity) {
    case "service":
      return applyService(context, row, linked);
    case "specialist":
      return applySpecialist(context, row, linked);
    case "client":
      return applyClient(context, row, linked);
  }
}

async function findByReference(
  context: ApplyContext,
  entity: ImportableEntity,
  externalId: string,
): Promise<string | null> {
  const [reference] = await context.tx
    .select({ localId: externalReferences.localId })
    .from(externalReferences)
    .where(
      and(
        eq(externalReferences.provider, IMPORT_PROVIDER),
        eq(externalReferences.entityType, entity),
        eq(externalReferences.externalId, externalId),
      ),
    )
    .limit(1);

  return reference?.localId ?? null;
}

/**
 * Guards the natural-key fallback against stealing a row that a different
 * source record already owns.
 *
 * The two identity kinds carry different authority, and the guard turns on
 * that difference:
 *
 * - two *external* ids are the source system's own assertion that these are
 *   two records. Merging them because they share a phone number would
 *   overwrite the first with the second and lose a client silently, so the
 *   match is refused and the row attempts its own insert — where the unique
 *   index surfaces the clash as a reported failure the owner can act on;
 * - a *fingerprint* is our own guess, derived from the natural key. When a
 *   client is renamed their fingerprint changes, so the old one is stale
 *   rather than a competing claim, and the natural-key match is the better
 *   evidence. Refusing here would turn every rename into a failed row.
 */
async function isClaimedByAnother(
  context: ApplyContext,
  entity: ImportableEntity,
  localId: string,
  row: MappedRow,
): Promise<boolean> {
  if (row.identityKind !== "external") return false;

  const [reference] = await context.tx
    .select({
      externalId: externalReferences.externalId,
      idKind: externalReferences.idKind,
    })
    .from(externalReferences)
    .where(
      and(
        eq(externalReferences.provider, IMPORT_PROVIDER),
        eq(externalReferences.entityType, entity),
        eq(externalReferences.localId, localId),
        eq(externalReferences.idKind, "external"),
      ),
    )
    .limit(1);

  return reference !== undefined && reference.externalId !== row.externalId;
}

/** Applies that guard to a candidate found by natural key. */
async function acceptCandidate(
  context: ApplyContext,
  entity: ImportableEntity,
  candidateId: string | undefined,
  row: MappedRow,
): Promise<string | null> {
  if (candidateId === undefined) return null;
  return (await isClaimedByAnother(context, entity, candidateId, row)) ? null : candidateId;
}

/**
 * Records the link, or refreshes it if the row was already known.
 *
 * `onConflictDoUpdate` rather than a read-then-write: two imports of the same
 * file started at once would both see no reference and both try to insert, and
 * the unique index would turn the second into a 500 instead of an update.
 */
async function linkReference(
  context: ApplyContext,
  entity: ImportableEntity,
  row: MappedRow,
  localId: string,
): Promise<void> {
  await context.tx
    .insert(externalReferences)
    .values({
      organizationId: context.organizationId,
      provider: IMPORT_PROVIDER,
      entityType: entity,
      externalId: row.externalId,
      localId,
      idKind: row.identityKind,
    })
    .onConflictDoUpdate({
      target: [
        externalReferences.organizationId,
        externalReferences.provider,
        externalReferences.entityType,
        externalReferences.externalId,
      ],
      set: { localId, updatedAt: new Date() },
    });
}

const text = (value: CellValue): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const number = (value: CellValue): number | null => (typeof value === "number" ? value : null);

async function applyService(
  context: ApplyContext,
  row: MappedRow,
  linkedId: string | null,
): Promise<RowResult> {
  const name = text(row.values.name)!;
  const priceMinor = number(row.values.price);
  const durationMinutes = number(row.values.duration);

  let serviceId = linkedId;

  if (serviceId === null) {
    // The localized name is jsonb, so the natural-key match reads the value at
    // the organization's own locale rather than comparing whole documents.
    const existing = await context.tx
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          isNull(services.archivedAt),
          sql`lower(${services.name} ->> ${context.locale}) = ${name.toLowerCase()}`,
        ),
      )
      .limit(1);
    serviceId = await acceptCandidate(context, "service", existing[0]?.id, row);
  }

  if (serviceId === null) {
    const [inserted] = await context.tx
      .insert(services)
      .values({
        organizationId: context.organizationId,
        name: { [context.locale]: name },
        priceMinor,
        durationMinutes,
        // SRV-002: a price is money, so it carries its currency from the start.
        currency: priceMinor === null ? null : context.currency,
        createdBy: context.actorUserId,
        updatedBy: context.actorUserId,
      })
      .returning({ id: services.id });
    await linkReference(context, "service", row, inserted.id);
    return "created";
  }

  await context.tx
    .update(services)
    .set({
      name: sql`${services.name} || ${JSON.stringify({ [context.locale]: name })}::jsonb`,
      // A blank cell means "not in this file", not "clear the price I already
      // have". Overwriting with null would silently un-cost every service.
      ...(priceMinor === null ? {} : { priceMinor, currency: context.currency }),
      ...(durationMinutes === null ? {} : { durationMinutes }),
      updatedBy: context.actorUserId,
      updatedAt: new Date(),
      version: sql`${services.version} + 1`,
    })
    .where(eq(services.id, serviceId));

  await linkReference(context, "service", row, serviceId);
  return "updated";
}

async function applySpecialist(
  context: ApplyContext,
  row: MappedRow,
  linkedId: string | null,
): Promise<RowResult> {
  const name = text(row.values.name)!;
  const cooperationType = (text(row.values.cooperation_type) ?? "commission") as
    | "commission"
    | "rent"
    | "staff";

  let specialistId = linkedId;
  let result: RowResult = "updated";

  if (specialistId === null) {
    const existing = await context.tx
      .select({ id: specialists.id })
      .from(specialists)
      .where(
        and(isNull(specialists.archivedAt), sql`lower(${specialists.name}) = ${name.toLowerCase()}`),
      )
      .limit(1);
    specialistId = await acceptCandidate(context, "specialist", existing[0]?.id, row);
  }

  if (specialistId === null) {
    const [inserted] = await context.tx
      .insert(specialists)
      .values({
        organizationId: context.organizationId,
        name,
        cooperationType,
        createdBy: context.actorUserId,
        updatedBy: context.actorUserId,
      })
      .returning({ id: specialists.id });
    specialistId = inserted.id;
    result = "created";
  } else {
    await context.tx
      .update(specialists)
      .set({
        name,
        cooperationType,
        updatedBy: context.actorUserId,
        updatedAt: new Date(),
        version: sql`${specialists.version} + 1`,
      })
      .where(eq(specialists.id, specialistId));
  }

  await linkReference(context, "specialist", row, specialistId);

  const basisPoints = number(row.values.commission_percent);
  if (basisPoints !== null) {
    await addCommissionRuleIfChanged(context, specialistId, basisPoints);
  }

  return result;
}

/**
 * Commission rules are versioned by `activeFrom` (CST-009), so writing one per
 * import would rewrite the specialist's history every time the same file is
 * loaded. A new rule is added only when the percentage genuinely differs from
 * the one in force.
 */
async function addCommissionRuleIfChanged(
  context: ApplyContext,
  specialistId: string,
  basisPoints: number,
): Promise<void> {
  const [current] = await context.tx
    .select({ basisPoints: commissionRules.basisPoints, type: commissionRules.type })
    .from(commissionRules)
    .where(and(eq(commissionRules.specialistId, specialistId), isNull(commissionRules.serviceId)))
    .orderBy(desc(commissionRules.activeFrom))
    .limit(1);

  if (current && current.type === "percentage" && current.basisPoints === basisPoints) return;

  await context.tx.insert(commissionRules).values({
    organizationId: context.organizationId,
    specialistId,
    type: "percentage",
    basisPoints,
    createdBy: context.actorUserId,
    updatedBy: context.actorUserId,
  });
}

async function applyClient(
  context: ApplyContext,
  row: MappedRow,
  linkedId: string | null,
): Promise<RowResult> {
  const name = text(row.values.name)!;
  const phone = text(row.values.phone);
  const email = text(row.values.email);

  let clientId = linkedId;

  if (clientId === null && phone !== null) {
    // Section 11.3 uniques on the normalized phone, so this is the same match
    // the database would enforce — done here so it becomes an update rather
    // than a constraint violation.
    const [existing] = await context.tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.normalizedPhone, phone))
      .limit(1);
    clientId = await acceptCandidate(context, "client", existing?.id, row);
  }

  if (clientId === null && email !== null) {
    const [existing] = await context.tx
      .select({ id: clients.id })
      .from(clients)
      .where(sql`lower(${clients.email}) = ${email.toLowerCase()}`)
      .limit(1);
    clientId = await acceptCandidate(context, "client", existing?.id, row);
  }

  if (clientId === null) {
    const [inserted] = await context.tx
      .insert(clients)
      .values({
        organizationId: context.organizationId,
        name,
        normalizedPhone: phone,
        email,
        createdBy: context.actorUserId,
        updatedBy: context.actorUserId,
      })
      .returning({ id: clients.id });
    await linkReference(context, "client", row, inserted.id);
    return "created";
  }

  await context.tx
    .update(clients)
    .set({
      name,
      ...(phone === null ? {} : { normalizedPhone: phone }),
      ...(email === null ? {} : { email }),
      updatedBy: context.actorUserId,
      updatedAt: new Date(),
      version: sql`${clients.version} + 1`,
    })
    .where(eq(clients.id, clientId));

  await linkReference(context, "client", row, clientId);
  return "updated";
}

/** Exported for the preview, which shows how a name will be matched. */
export { normalizeKeyPart };
