import { eq } from "drizzle-orm";
import { z } from "zod";

import { importJobs, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { CsvDelimiter } from "@/domain/csv";
import { isImportableEntity } from "@/domain/import-templates";
import { canImport, previewFor, serializePreview, templateFields } from "@/lib/import-flow";
import { apiError, apiSuccess, requestId, toFieldErrors } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";
import type { AppLocale } from "@/i18n/messages";

const patchSchema = z.object({
  /** Field key -> column index, or null to leave the field unmapped. */
  mapping: z.record(z.string(), z.int().min(0).nullable()),
});

/**
 * The mapping step of INT-002: the owner corrects a column and gets a fresh
 * validation preview against the same stored file.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const actor = caller.membership;
  const { id: jobId } = await context.params;

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, "VALIDATION_ERROR", "The request body is invalid", id, {
      fieldErrors: toFieldErrors(parsed.error.issues),
    });
  }

  const result = await withTenant(actor.organizationId, async (tx) => {
    const [job] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    if (!job) return { error: "NOT_FOUND" as const };
    if (!isImportableEntity(job.entityType)) return { error: "NOT_FOUND" as const };
    // Permission before state, as in confirm: a role that may not touch this
    // import should be told so whether or not the job has already been applied.
    if (!canImport(actor.role, job.entityType)) return { error: "FORBIDDEN" as const };
    if (job.status !== "uploaded" || job.sourceText === null) {
      return { error: "ALREADY_COMPLETED" as const };
    }

    // Only keys the template declares, and only columns the file has. A mapping
    // posted with an out-of-range index would otherwise read undefined cells
    // and quietly present every row as empty.
    const allowed = new Set(templateFields(job.entityType).map((field) => field.key));
    const mapping: Record<string, number | null> = {};
    for (const [key, column] of Object.entries(parsed.data.mapping)) {
      if (!allowed.has(key)) continue;
      mapping[key] = column !== null && column < job.headers.length ? column : null;
    }

    await tx.update(importJobs).set({ mapping }).where(eq(importJobs.id, jobId));

    const [organization] = await tx
      .select({ currency: organizations.currency, locale: organizations.locale })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    const preview = previewFor(
      job.entityType,
      job.sourceText,
      job.delimiter as CsvDelimiter,
      mapping,
    );

    return {
      job,
      entity: job.entityType,
      mapping,
      preview: serializePreview(job.entityType, preview, {
        currency: organization.currency,
        locale: organization.locale as AppLocale,
      }),
    };
  });

  if ("error" in result) {
    if (result.error === "NOT_FOUND") return apiError(404, "NOT_FOUND", "Import job not found", id);
    if (result.error === "FORBIDDEN") {
      return apiError(403, "FORBIDDEN", "This role cannot import this data", id);
    }
    return apiError(409, "ALREADY_COMPLETED", "This import has already been applied", id);
  }

  return apiSuccess(
    {
      id: jobId,
      entity: result.entity,
      headers: result.job.headers,
      fields: templateFields(result.entity),
      mapping: result.mapping,
      preview: result.preview,
    },
    id,
  );
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const { id: jobId } = await context.params;

  const found = await withTenant(caller.membership.organizationId, async (tx) => {
    const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    if (!row) return null;
    const [organization] = await tx
      .select({ currency: organizations.currency, locale: organizations.locale })
      .from(organizations)
      .where(eq(organizations.id, caller.membership!.organizationId))
      .limit(1);
    return { job: row, organization };
  });

  const job = found?.job ?? null;

  if (!job || !isImportableEntity(job.entityType)) {
    return apiError(404, "NOT_FOUND", "Import job not found", id);
  }

  // The preview below is the file's own rows — for a client import, names and
  // phone numbers. Reading it is the same act as importing it, so it takes the
  // same permission: section 6.1 lets an Analyst read client history "без
  // телефонов и email", and a job detail must not be the way around that.
  if (!canImport(caller.membership.role, job.entityType)) {
    return apiError(403, "FORBIDDEN", "This role cannot read this import", id);
  }

  return apiSuccess(
    {
      id: job.id,
      entity: job.entityType,
      status: job.status,
      file_name: job.fileName,
      encoding: job.encoding,
      delimiter: job.delimiter,
      headers: job.headers,
      fields: templateFields(job.entityType),
      mapping: job.mapping,
      result: {
        created: job.createdCount,
        updated: job.updatedCount,
        skipped: job.skippedCount,
        failed: job.failedCount,
        issues: job.issues,
      },
      // Recomputed rather than stored: the stored text is cleared on
      // completion, so a finished job shows its counts and not a stale preview.
      preview:
        job.status === "uploaded" && job.sourceText !== null
          ? serializePreview(
              job.entityType,
              previewFor(
                job.entityType,
                job.sourceText,
                job.delimiter as CsvDelimiter,
                job.mapping,
              ),
              {
                currency: found!.organization.currency,
                locale: found!.organization.locale as AppLocale,
              },
            )
          : null,
    },
    id,
  );
}
