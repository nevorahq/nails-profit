import { desc } from "drizzle-orm";

import { ToolIcon } from "@/components/icons";
import { ImportWizard } from "@/components/import-wizard";
import { importJobs } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { importableEntities } from "@/domain/import-templates";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { canImport } from "@/lib/import-flow";
import { requireWorkspace } from "@/lib/workspace";

export default async function ImportPage() {
  const { membership, locale } = await requireWorkspace();
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
        {/*
          The compose action. Two shapes of the one control, exactly as the
          calendar's own toolbar and round button are (`app/app/calendar/page.tsx`):
          a labelled toggle for a desktop, a round one for a phone. Both point
          at the upload `.compose-wrap` `components/import-wizard.tsx` renders;
          the click handling that opens (and, for either anchor, closes) it
          lives there, since this is a Server Component and cannot hold it.
        */}
        <a className="primary-button calendar-create" href="#import-upload">
          <ToolIcon name="plus" />
          {t("import.upload")}
        </a>
        <a
          className="header-action"
          href="#import-upload"
          aria-label={t("import.upload")}
          data-label-closed={t("import.upload")}
          data-label-open={t("import.hideUploadTitle")}
        >
          <ToolIcon name="plus" />
          <ToolIcon name="minus" />
        </a>
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
