import { desc } from "drizzle-orm";

import { AppNav } from "@/components/app-nav";
import { ImportWizard } from "@/components/import-wizard";
import { importJobs } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { importableEntities } from "@/domain/import-templates";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { canImport } from "@/lib/import-flow";
import { requireWorkspace } from "@/lib/workspace";

export default async function ImportPage() {
  const { membership, organizationName, locale } = await requireWorkspace();
  const t = getTranslator(locale);

  // Only the entities this role may actually write. Offering a choice that will
  // be refused at confirm wastes the owner's file and their trust.
  const allowed = importableEntities.filter((entity) => canImport(membership.role, entity));

  if (allowed.length === 0) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("import.noRights")}</p>
      </main>
    );
  }

  const history = await withTenant(membership.organizationId, (tx) =>
    tx
      .select({
        id: importJobs.id,
        entity: importJobs.entityType,
        status: importJobs.status,
        fileName: importJobs.fileName,
        created: importJobs.createdCount,
        updated: importJobs.updatedCount,
        skipped: importJobs.skippedCount,
        failed: importJobs.failedCount,
        createdAt: importJobs.createdAt,
      })
      .from(importJobs)
      .orderBy(desc(importJobs.createdAt))
      .limit(10),
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">{organizationName}</span>
          <h1>{t("import.title")}</h1>
        </div>
        <AppNav active="/app/import" locale={locale} />
      </header>

      <ImportWizard entities={allowed} locale={locale} />

      {history.length > 0 && (
        <section className="panel">
          <h2>{t("import.history")}</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("import.when")}</th>
                <th>{t("import.fileName")}</th>
                <th>{t("import.what.column")}</th>
                <th>{t("import.created")}</th>
                <th>{t("import.updated")}</th>
                <th>{t("import.skipped")}</th>
                <th>{t("import.failed")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((job) => (
                <tr key={job.id}>
                  <td>{job.createdAt.toLocaleDateString(localeTag(locale))}</td>
                  <td>{job.fileName}</td>
                  <td>{t(`entity.${job.entity}` as MessageKey)}</td>
                  {job.status === "completed" ? (
                    <>
                      <td>{job.created}</td>
                      <td>{job.updated}</td>
                      <td>{job.skipped}</td>
                      <td className={job.failed > 0 ? "metric-negative" : ""}>{job.failed}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="muted">
                      {t("import.notConfirmed")}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
