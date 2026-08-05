import { desc, eq } from "drizzle-orm";

import { importJobs, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { decodeCsv, detectDelimiter, parseCsv } from "@/domain/csv";
import { suggestMapping } from "@/domain/import-mapping";
import { importTemplates, isImportableEntity } from "@/domain/import-templates";
import { canImport, MAX_IMPORT_BYTES, previewFor, serializePreview, templateFields } from "@/lib/import-flow";
import { apiError, apiSuccess, rateLimited, requestId } from "@/lib/http";
import { callerKey, checkRateLimit, IMPORT_UPLOAD_RULE } from "@/lib/rate-limit";
import { getActiveMembership } from "@/lib/membership";
import type { AppLocale } from "@/i18n/messages";

/**
 * Upload, the first step of INT-002.
 *
 * The file is parsed and stored, and the response is a preview with a suggested
 * mapping — nothing is written to the catalogue until the owner confirms. The
 * two steps read the same stored bytes, so what is applied is what was shown.
 */
export async function POST(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }
  const actor = caller.membership;

  // Before the body is read, not after: the point is to avoid decoding and
  // parsing two megabytes for a caller that is already over the limit.
  const limit = checkRateLimit(callerKey(request, actor.userId), IMPORT_UPLOAD_RULE);
  if (!limit.allowed) {
    return rateLimited(id, limit.retryAfterSeconds, {
      bucket: "import.upload",
      organizationId: actor.organizationId,
      userId: actor.userId,
    });
  }

  const form = await request.formData().catch(() => null);
  const entity = String(form?.get("entity") ?? "");
  const file = form?.get("file");

  if (!isImportableEntity(entity)) {
    return apiError(422, "VALIDATION_ERROR", "Unknown import entity", id, {
      fieldErrors: [{ field: "entity", code: "invalid", message: "Unknown import entity" }],
    });
  }
  if (!canImport(actor.role, entity)) {
    return apiError(403, "FORBIDDEN", "This role cannot import this data", id);
  }
  if (!(file instanceof File) || file.size === 0) {
    return apiError(422, "VALIDATION_ERROR", "A non-empty file is required", id, {
      fieldErrors: [{ field: "file", code: "required", message: "A non-empty file is required" }],
    });
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return apiError(413, "FILE_TOO_LARGE", "The file exceeds the import size limit", id, {
      details: { max_bytes: MAX_IMPORT_BYTES },
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodeCsv(bytes);
  const delimiter = detectDelimiter(decoded.text);
  const parsed = parseCsv(decoded.text, delimiter);

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return apiError(422, "EMPTY_FILE", "The file has no data rows", id);
  }

  const mapping = suggestMapping(importTemplates[entity], parsed.headers);
  const preview = previewFor(entity, decoded.text, delimiter, mapping);

  const job = await withTenant(actor.organizationId, async (tx) => {
    const [organization] = await tx
      .select({ currency: organizations.currency, locale: organizations.locale })
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId))
      .limit(1);

    const [created] = await tx
      .insert(importJobs)
      .values({
        organizationId: actor.organizationId,
        entityType: entity,
        fileName: file.name,
        delimiter,
        encoding: decoded.encoding,
        sourceText: decoded.text,
        headers: [...parsed.headers],
        mapping,
        createdBy: actor.userId,
      })
      .returning({ id: importJobs.id, createdAt: importJobs.createdAt });
    return { ...created, currency: organization.currency, locale: organization.locale };
  });

  return apiSuccess(
    {
      id: job.id,
      entity,
      file_name: file.name,
      encoding: decoded.encoding,
      delimiter,
      headers: parsed.headers,
      fields: templateFields(entity),
      mapping,
      preview: serializePreview(entity, preview, {
        currency: job.currency,
        locale: job.locale as AppLocale,
      }),
    },
    id,
    201,
  );
}

/** Past imports, so a result can be reopened after the fact. */
export async function GET(request: Request) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);
  if (!caller.membership) {
    return apiError(404, "MEMBERSHIP_NOT_FOUND", "User does not belong to an organization", id);
  }

  const rows = await withTenant(caller.membership.organizationId, (tx) =>
    tx
      .select({
        id: importJobs.id,
        entity: importJobs.entityType,
        status: importJobs.status,
        file_name: importJobs.fileName,
        created: importJobs.createdCount,
        updated: importJobs.updatedCount,
        skipped: importJobs.skippedCount,
        failed: importJobs.failedCount,
        created_at: importJobs.createdAt,
        completed_at: importJobs.completedAt,
      })
      .from(importJobs)
      .orderBy(desc(importJobs.createdAt))
      .limit(50),
  );

  // Filtered rather than refused: the list is a history of what the role may
  // import, so a Master sees an empty one instead of a wall.
  const visible = rows.filter(
    (row) => isImportableEntity(row.entity) && canImport(caller.membership!.role, row.entity),
  );

  return apiSuccess(visible, id);
}
