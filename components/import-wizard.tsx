"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * The five steps of INT-002 as one screen: upload, mapping, validation preview,
 * confirm, result.
 *
 * Kept on one screen on purpose. The mapping is only worth checking against the
 * rows it produces, and a wizard that hides the preview behind a "next" button
 * asks the owner to approve a column assignment they cannot yet see the effect
 * of.
 */

export type ImportField = {
  key: string;
  label: string;
  required: boolean;
  type: string;
  hint: string | null;
  options: string[] | null;
};

type PreviewIssue = { field: string; code: string; value: string };

type Preview = {
  missing_required_fields: string[];
  total: number;
  failed_count: number;
  skipped_count: number;
  sample: { line: number; identity_kind: string; values: { key: string; value: string }[] }[];
  failed: { line: number; issues: PreviewIssue[] }[];
  skipped: { line: number; issues: PreviewIssue[] }[];
  warnings: { line: number; field: string; code: string; value: string }[];
};

type Job = {
  id: string;
  entity: string;
  file_name: string;
  encoding: string;
  delimiter: string;
  headers: string[];
  fields: ImportField[];
  mapping: Record<string, number | null>;
  preview: Preview;
};

type Result = { created: number; updated: number; skipped: number; failed: number };

const encodingLabels: Record<string, string> = {
  "utf-8": "UTF-8",
  "windows-1251": "Windows-1251",
};

export function ImportWizard({ entities, locale }: { entities: string[]; locale: AppLocale }) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [entity, setEntity] = useState(entities[0] ?? "material");
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);

    const data = new FormData(event.currentTarget);
    data.set("entity", entity);

    const response = await fetch("/api/v1/imports", { method: "POST", body: data });
    const body = await response.json();
    setPending(false);

    if (!response.ok) {
      setError(body?.error?.message ?? t("import.readFailed"));
      return;
    }
    setJob(body.data);
  }

  async function remap(fieldKey: string, column: number | null) {
    if (!job) return;
    const mapping = { ...job.mapping, [fieldKey]: column };
    setPending(true);

    const response = await fetch(`/api/v1/imports/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mapping }),
    });
    const body = await response.json();
    setPending(false);

    if (!response.ok) {
      setError(body?.error?.message ?? t("import.recalcFailed"));
      return;
    }
    setJob({ ...job, mapping: body.data.mapping, preview: body.data.preview });
  }

  async function confirm() {
    if (!job) return;
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/imports/${job.id}/confirm`, { method: "POST" });
    const body = await response.json();
    setPending(false);

    if (!response.ok) {
      setError(body?.error?.message ?? t("import.importFailed"));
      return;
    }
    setResult(body.data.result);
    setJob(null);
    router.refresh();
  }

  if (result) {
    return (
      <section className="panel">
        <h2>{t("import.done")}</h2>
        <div className="metric-grid">
          <div className="metric metric-strong">
            <span>{t("import.created")}</span>
            <strong>{result.created}</strong>
          </div>
          <div className="metric">
            <span>{t("import.updated")}</span>
            <strong>{result.updated}</strong>
          </div>
          <div className="metric">
            <span>{t("import.skipped")}</span>
            <strong>{result.skipped}</strong>
          </div>
          <div className={`metric${result.failed > 0 ? " metric-negative" : ""}`}>
            <span>{t("import.failed")}</span>
            <strong>{result.failed}</strong>
          </div>
        </div>
        {result.failed > 0 && (
          <p className="muted">
{t("import.failedNote")}
          </p>
        )}
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => setResult(null)}>
            {t("import.again")}
          </button>
        </div>
      </section>
    );
  }

  if (!job) {
    return (
      <>
        <div className="add-form-toggle">
          {formOpen ? (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn-toggle-close" type="button" onClick={() => setFormOpen(false)} aria-label={t("common.cancel")}>−</button>
            </div>
          ) : (
            <button className="primary-button" type="button" style={{ width: "100%" }} onClick={() => setFormOpen(true)}>
              {t("import.upload")}
            </button>
          )}
        </div>
        <div className={`add-form-wrap${formOpen ? "" : " add-form-closed"}`}>
          <div className="add-form-inner">
            <section className="panel">
              <h2>{t("import.upload")}</h2>
              <form className="inline-form" onSubmit={upload}>
                <label>
                  {t("import.what")}
                  <select value={entity} onChange={(event) => setEntity(event.target.value)}>
                    {entities.map((option) => (
                      <option key={option} value={option}>
                        {t(`entity.${option}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("import.file")}
                  <input type="file" name="file" accept=".csv,text/csv" required />
                </label>
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("import.reading") : t("import.submit")}
                </button>
              </form>
              {error && <p className="form-error" role="alert">{error}</p>}
              <p className="muted">
{t("import.hint")}{" "}
                <a className="text-link" href={`/api/v1/imports/templates/${entity}`}>
                  {t("import.downloadTemplate")}
                </a>
              </p>
            </section>
          </div>
        </div>
      </>
    );
  }

  const preview = job.preview;
  const blocked = preview.missing_required_fields.length > 0;

  return (
    <>
      <section className="panel">
        <h2>{t("import.columns")}</h2>
        <p className="muted">
          {job.file_name} · {encodingLabels[job.encoding] ?? job.encoding} ·{" "}
          {t("import.separator", {
            separator: job.delimiter === "\t" ? t("import.separatorTab") : job.delimiter,
          })}
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("import.field")}</th>
              <th>{t("import.column")}</th>
            </tr>
          </thead>
          <tbody>
            {job.fields.map((field) => (
              <tr key={field.key}>
                <td>
                  {field.label}
                  {field.required && <span className="badge-warning">{t("import.required")}</span>}
                  {field.hint && <span className="unit-hint">{field.hint}</span>}
                </td>
                <td>
                  <select
                    aria-label={`${t("import.column")} — ${field.label}`}
                    value={job.mapping[field.key] ?? ""}
                    disabled={pending}
                    onChange={(event) =>
                      remap(field.key, event.target.value === "" ? null : Number(event.target.value))
                    }
                  >
                    <option value="">{t("import.doNotImport")}</option>
                    {job.headers.map((header, index) => (
                      <option key={`${header}-${index}`} value={index}>
                        {header || t("import.columnNumber", { number: index + 1 })}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {blocked && (
        <div className="warning-banner">
          {t("import.missingRequired", {
            fields: preview.missing_required_fields
              .map((key) => job.fields.find((field) => field.key === key)?.label ?? key)
              .join(", "),
          })}
        </div>
      )}

      {!blocked && (
        <section className="panel">
          <h2>{t("import.willWrite")}</h2>
          <div className="metric-grid">
            <div className="metric metric-strong">
              <span>{t("import.rowsReady")}</span>
              <strong>{preview.total}</strong>
            </div>
            <div className={`metric${preview.failed_count > 0 ? " metric-negative" : ""}`}>
              <span>{t("import.failed")}</span>
              <strong>{preview.failed_count}</strong>
            </div>
            <div className="metric">
              <span>{t("import.rowsDuplicate")}</span>
              <strong>{preview.skipped_count}</strong>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>{t("common.line")}</th>
                {job.fields
                  .filter((field) => job.mapping[field.key] !== null)
                  .map((field) => (
                    <th key={field.key}>{field.label}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row) => (
                <tr key={row.line}>
                  <td className="muted">{row.line}</td>
                  {job.fields
                    .filter((field) => job.mapping[field.key] !== null)
                    .map((field) => (
                      <td key={field.key}>
                        {row.values.find((value) => value.key === field.key)?.value || (
                          <span className="muted">—</span>
                        )}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.total > preview.sample.length && (
            <p className="muted">
              {t("import.showingFirst", { shown: preview.sample.length, total: preview.total })}
            </p>
          )}
        </section>
      )}

      {preview.failed.length > 0 && (
        <section className="panel">
          <h2>{t("import.failedTitle")}</h2>
          <p className="muted">{t("import.failedHint")}</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("common.line")}</th>
                <th>{t("import.whatIsWrong")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.failed.map((row) => (
                <tr key={row.line}>
                  <td>{row.line}</td>
                  <td>
                    {row.issues.map((issue, index) => {
                      const field = job.fields.find((item) => item.key === issue.field);
                      return (
                        <span key={`${issue.field}-${index}`} className="badge-warning">
                          {field?.label ?? issue.field}: {t(`issue.${issue.code}` as MessageKey)}
                          {issue.value && ` («${issue.value}»)`}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview.skipped.length > 0 && (
        <section className="panel">
          <h2>{t("import.duplicatesTitle")}</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("common.line")}</th>
                <th>{t("import.alreadySeen")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.skipped.map((row) => (
                <tr key={row.line}>
                  <td>{row.line}</td>
                  <td className="muted">{row.issues[0]?.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview.warnings.length > 0 && (
        <div className="warning-banner">
          {t("import.formulaWarning", { count: preview.warnings.length })}
        </div>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          onClick={confirm}
          disabled={pending || blocked || preview.total === 0}
        >
          {pending ? t("import.importing") : t("import.confirm", { count: preview.total })}
        </button>
        <button className="secondary-button" type="button" onClick={() => setJob(null)}>
          {t("common.cancel")}
        </button>
      </div>
    </>
  );
}
