import { desc } from "drizzle-orm";
import Link from "next/link";

import { importJobs } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { importableEntities } from "@/domain/import-templates";
import { ImportWizard } from "@/components/import-wizard";
import { canImport } from "@/lib/import-flow";
import { requireWorkspace } from "@/lib/workspace";

const entityLabels: Record<string, string> = {
  material: "Материалы",
  service: "Услуги",
  specialist: "Мастера",
  client: "Клиенты",
};

export default async function ImportPage() {
  const { membership, organizationName } = await requireWorkspace();

  // Only the entities this role may actually write. Offering a choice that will
  // be refused at confirm wastes the owner's file and their trust.
  const allowed = importableEntities.filter((entity) => canImport(membership.role, entity));

  if (allowed.length === 0) {
    return (
      <main className="app-shell">
        <p className="warning-banner">У вашей роли нет прав на импорт данных.</p>
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
          <h1>Импорт</h1>
        </div>
        <nav className="tab-nav">
          <Link href="/app">Отчёт</Link>
          <Link href="/app/visits">Визиты</Link>
          <Link href="/app/services">Услуги</Link>
          <Link href="/app/add-ons">Опции</Link>
          <Link href="/app/materials">Материалы</Link>
          <Link href="/app/specialists">Мастера</Link>
          <Link className="active" href="/app/import">
            Импорт
          </Link>
        </nav>
      </header>

      <ImportWizard entities={allowed} />

      {history.length > 0 && (
        <section className="panel">
          <h2>Прошлые импорты</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Файл</th>
                <th>Что</th>
                <th>Добавлено</th>
                <th>Обновлено</th>
                <th>Пропущено</th>
                <th>С ошибками</th>
              </tr>
            </thead>
            <tbody>
              {history.map((job) => (
                <tr key={job.id}>
                  <td>{job.createdAt.toLocaleDateString("ru-MD")}</td>
                  <td>{job.fileName}</td>
                  <td>{entityLabels[job.entity] ?? job.entity}</td>
                  {job.status === "completed" ? (
                    <>
                      <td>{job.created}</td>
                      <td>{job.updated}</td>
                      <td>{job.skipped}</td>
                      <td className={job.failed > 0 ? "metric-negative" : ""}>{job.failed}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="muted">
                      не подтверждён
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
