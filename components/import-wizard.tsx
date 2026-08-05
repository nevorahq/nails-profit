"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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

const entityLabels: Record<string, string> = {
  material: "Материалы",
  service: "Услуги",
  specialist: "Мастера",
  client: "Клиенты",
};

/** Wording an owner can act on, rather than the code the API returns. */
const issueLabels: Record<string, string> = {
  required_missing: "обязательное поле пустое",
  not_a_number: "не похоже на число",
  not_a_date: "не похоже на дату",
  not_a_duration: "не похоже на длительность",
  not_a_boolean: "нужно «да» или «нет»",
  not_a_phone: "не похоже на телефон",
  not_an_option: "недопустимое значение",
  negative_not_allowed: "отрицательное значение",
  too_long: "слишком длинное значение",
  duplicate_in_file: "повтор строки в файле",
  looks_like_formula: "значение начинается как формула Excel — импортируем как текст",
  write_failed: "не удалось записать",
};

const encodingLabels: Record<string, string> = {
  "utf-8": "UTF-8",
  "windows-1251": "Windows-1251",
};

/**
 * Russian plurals: 1 строка, 2 строки, 5 строк. `Intl.PluralRules` knows the
 * categories, which is shorter and more honest than hand-written modulo
 * arithmetic — and it is the same mechanism the ro and en interfaces will need.
 */
const pluralRules = new Intl.PluralRules("ru-RU");

function plural(count: number, forms: { one: string; few: string; many: string }): string {
  const category = pluralRules.select(count);
  if (category === "one") return forms.one;
  if (category === "few") return forms.few;
  return forms.many;
}

export function ImportWizard({ entities }: { entities: string[] }) {
  const router = useRouter();
  const [entity, setEntity] = useState(entities[0] ?? "material");
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      setError(body?.error?.message ?? "Не удалось прочитать файл");
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
      setError(body?.error?.message ?? "Не удалось пересчитать");
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
      setError(body?.error?.message ?? "Не удалось импортировать");
      return;
    }
    setResult(body.data.result);
    setJob(null);
    router.refresh();
  }

  if (result) {
    return (
      <section className="panel">
        <h2>Импорт завершён</h2>
        <div className="metric-grid">
          <div className="metric metric-strong">
            <span>Добавлено</span>
            <strong>{result.created}</strong>
          </div>
          <div className="metric">
            <span>Обновлено</span>
            <strong>{result.updated}</strong>
          </div>
          <div className="metric">
            <span>Пропущено</span>
            <strong>{result.skipped}</strong>
          </div>
          <div className={`metric${result.failed > 0 ? " metric-negative" : ""}`}>
            <span>С ошибками</span>
            <strong>{result.failed}</strong>
          </div>
        </div>
        {result.failed > 0 && (
          <p className="muted">
            Строки с ошибками не импортированы — остальные записаны. Исправьте их в файле и загрузите
            его ещё раз: повторный импорт обновит существующие записи, а не создаст копии.
          </p>
        )}
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => setResult(null)}>
            Импортировать ещё
          </button>
        </div>
      </section>
    );
  }

  if (!job) {
    return (
      <section className="panel">
        <h2>Загрузите файл</h2>
        <form className="inline-form" onSubmit={upload}>
          <label>
            Что импортируем
            <select value={entity} onChange={(event) => setEntity(event.target.value)}>
              {entities.map((option) => (
                <option key={option} value={option}>
                  {entityLabels[option] ?? option}
                </option>
              ))}
            </select>
          </label>
          <label>
            Файл CSV
            <input type="file" name="file" accept=".csv,text/csv" required />
          </label>
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? "Читаем…" : "Загрузить"}
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
        <p className="muted">
          Подойдёт выгрузка из Excel — и с запятой, и с точкой с запятой, в UTF-8 или Windows-1251.
          Ничего не записывается, пока вы не подтвердите.{" "}
          <a className="text-link" href={`/api/v1/imports/templates/${entity}`}>
            Скачать шаблон
          </a>
        </p>
      </section>
    );
  }

  const preview = job.preview;
  const blocked = preview.missing_required_fields.length > 0;

  return (
    <>
      <section className="panel">
        <h2>Колонки</h2>
        <p className="muted">
          {job.file_name} · {encodingLabels[job.encoding] ?? job.encoding} · разделитель «
          {job.delimiter === "\t" ? "таб" : job.delimiter}»
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Поле</th>
              <th>Колонка в файле</th>
            </tr>
          </thead>
          <tbody>
            {job.fields.map((field) => (
              <tr key={field.key}>
                <td>
                  {field.label}
                  {field.required && <span className="badge-warning">обязательно</span>}
                  {field.hint && <span className="unit-hint">{field.hint}</span>}
                </td>
                <td>
                  <select
                    value={job.mapping[field.key] ?? ""}
                    disabled={pending}
                    onChange={(event) =>
                      remap(field.key, event.target.value === "" ? null : Number(event.target.value))
                    }
                  >
                    <option value="">— не импортировать —</option>
                    {job.headers.map((header, index) => (
                      <option key={`${header}-${index}`} value={index}>
                        {header || `колонка ${index + 1}`}
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
          Не выбраны обязательные колонки:{" "}
          {preview.missing_required_fields
            .map((key) => job.fields.find((field) => field.key === key)?.label ?? key)
            .join(", ")}
          . Пока они не заданы, импортировать нечего.
        </div>
      )}

      {!blocked && (
        <section className="panel">
          <h2>Что будет записано</h2>
          <div className="metric-grid">
            <div className="metric metric-strong">
              <span>Строк готово</span>
              <strong>{preview.total}</strong>
            </div>
            <div className={`metric${preview.failed_count > 0 ? " metric-negative" : ""}`}>
              <span>С ошибками</span>
              <strong>{preview.failed_count}</strong>
            </div>
            <div className="metric">
              <span>Повторов в файле</span>
              <strong>{preview.skipped_count}</strong>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Строка</th>
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
              Показаны первые {preview.sample.length} из {preview.total}{" "}
              {plural(preview.total, { one: "строки", few: "строк", many: "строк" })}.
            </p>
          )}
        </section>
      )}

      {preview.failed.length > 0 && (
        <section className="panel">
          <h2>Строки с ошибками</h2>
          <p className="muted">
            Эти строки не будут импортированы. Остальные — будут. Номер строки совпадает с номером в
            вашем файле.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Строка</th>
                <th>Что не так</th>
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
                          {field?.label ?? issue.field}: {issueLabels[issue.code] ?? issue.code}
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
          <h2>Повторы внутри файла</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Строка</th>
                <th>Уже встречалась</th>
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
          В {preview.warnings.length}{" "}
          {plural(preview.warnings.length, { one: "строке", few: "строках", many: "строках" })}{" "}
          значение начинается как формула Excel. Импортируем как обычный текст — при выгрузке формула
          не выполнится.
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          onClick={confirm}
          disabled={pending || blocked || preview.total === 0}
        >
          {pending
            ? "Импортируем…"
            : `Импортировать ${preview.total} ${plural(preview.total, {
                one: "строку",
                few: "строки",
                many: "строк",
              })}`}
        </button>
        <button className="secondary-button" type="button" onClick={() => setJob(null)}>
          Отмена
        </button>
      </div>
    </>
  );
}
