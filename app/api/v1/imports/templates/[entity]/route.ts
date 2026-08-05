import { toCsv } from "@/domain/csv-safety";
import { isImportableEntity, templateSample } from "@/domain/import-templates";
import { apiError, requestId } from "@/lib/http";
import { getActiveMembership } from "@/lib/membership";

/**
 * The example file offered at the upload step.
 *
 * Served through `toCsv`, so it carries the BOM and `;` that Excel on a Russian
 * or Romanian Windows expects — a template that opens as mojibake or as one
 * column teaches the owner that the import does not work before they have tried
 * their own file.
 */
export async function GET(request: Request, context: { params: Promise<{ entity: string }> }) {
  const id = requestId(request);
  const caller = await getActiveMembership();
  if (!caller.session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const { entity } = await context.params;
  if (!isImportableEntity(entity)) {
    return apiError(404, "NOT_FOUND", "Unknown import entity", id);
  }

  return new Response(toCsv(templateSample(entity)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="nail-profit-${entity}.csv"`,
      "x-request-id": id,
    },
  });
}
