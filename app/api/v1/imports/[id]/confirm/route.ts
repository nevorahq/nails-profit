import { eq } from "drizzle-orm";

import { importJobs, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { CsvDelimiter } from "@/domain/csv";
import type { RowIssue } from "@/domain/import-mapping";
import { isImportableEntity } from "@/domain/import-templates";
import type { Currency } from "@/domain/money";
import type { AppLocale } from "@/i18n/messages";
import { recordAuditEvent } from "@/lib/audit";
import { apiError, apiSuccess, rateLimited, requestId } from "@/lib/http";
import { logEvent } from "@/lib/logger";
import { callerKey, checkRateLimit, IMPORT_CONFIRM_RULE } from "@/lib/rate-limit";
import { canImport, previewFor } from "@/lib/import-flow";
import { applyImport } from "@/lib/import-service";
import { getActiveMembership } from "@/lib/membership";

/**
 * Confirm and result, the last two steps of INT-002.
 *
 * The preview is recomputed here from the stored file rather than trusted from
 * the client: a caller that posted its own row list could write anything it
 * liked past validation. Recomputing also means confirm applies exactly what
 * the mapping step displayed.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const actor = caller.membership;

  // Confirm writes the catalogue row by row, so it is limited too — a loop here
  // costs the database, not just this process.
  const limit = checkRateLimit(callerKey(request, actor.userId), IMPORT_CONFIRM_RULE);
  if (!limit.allowed) {
    return rateLimited(id, limit.retryAfterSeconds, {
      bucket: "import.confirm",
      organizationId: actor.organizationId,
      userId: actor.userId,
    });
  }

  const { id: jobId } = await context.params;

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [job] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    if (!job) return { error: "NOT_FOUND" as const };
    if (!isImportableEntity(job.entityType)) return { error: "NOT_FOUND" as const };
    if (!canImport(actor.role, job.entityType)) return { error: "FORBIDDEN" as const };
    // INT-004: applying the same job twice is not a second import. The status
    // check is what makes a double-clicked confirm harmless.
    if (job.status !== "uploaded" || job.sourceText === null) {
      return { error: "ALREADY_COMPLETED" as const };
    }

    const [organization] = await tx
      .select({ currency: organizations.currency, locale: organizations.locale })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    const preview = previewFor(
      job.entityType,
      job.sourceText,
      job.delimiter as CsvDelimiter,
      job.mapping,
    );

    if (preview.missingRequiredFields.length > 0) {
      return { error: "MAPPING_INCOMPLETE" as const, fields: preview.missingRequiredFields };
    }

    const outcome = await applyImport(
      {
        tx,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        currency: organization.currency as Currency,
        locale: organization.locale as AppLocale,
      },
      job.entityType,
      preview.rows,
    );

    // Rows that never reached the writer are part of the result too: INT-005
    // asks for created/updated/skipped/failed over the whole file, not over
    // the subset that happened to be valid.
    const issues: RowIssue[] = [
      ...preview.failed.flatMap((row) => row.issues),
      ...preview.skipped.flatMap((row) => row.issues),
      ...outcome.issues,
    ];

    const counts = {
      created: outcome.created,
      updated: outcome.updated,
      skipped: outcome.skipped + preview.skipped.length,
      failed: outcome.failed + preview.failed.length,
    };

    await tx
      .update(importJobs)
      .set({
        status: "completed",
        createdCount: counts.created,
        updatedCount: counts.updated,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
        issues,
        // The raw file is dropped once its rows are in: a client list is PII,
        // and section 15.3 gives no reason to keep it. Mapping and counts stay,
        // which is what "where did this row come from" actually needs.
        sourceText: null,
        completedAt: new Date(),
      })
      .where(eq(importJobs.id, jobId));

    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      eventType: "import.completed",
      entityType: "import_job",
      entityId: jobId,
      after: { entity: job.entityType, file_name: job.fileName, ...counts },
      requestId: id,
    });

    return { counts, issues };
  });

  if ("error" in result) {
    if (result.error === "NOT_FOUND") return apiError(404, "NOT_FOUND", "Import job not found", id);
    if (result.error === "FORBIDDEN") {
      return apiError(403, "FORBIDDEN", "This role cannot import this data", id);
    }
    if (result.error === "MAPPING_INCOMPLETE") {
      return apiError(422, "MAPPING_INCOMPLETE", "Required columns are not mapped", id, {
        details: { fields: result.fields },
      });
    }
    return apiError(409, "ALREADY_COMPLETED", "This import has already been applied", id);
  }

  // Section 15.6 asks for import failures among the metrics. Counts only: the
  // rows themselves are the customer's data, and the file name can be a person.
  logEvent(
    "info",
    "import.completed",
    { requestId: id, organizationId: actor.organizationId, userId: actor.userId },
    { ...result.counts, issues: result.issues.length },
  );

  return apiSuccess({ id: jobId, result: result.counts, issues: result.issues }, id);
}
