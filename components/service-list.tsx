"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

import { NameCombobox } from "@/components/name-combobox";
import {
  serviceCatalogue,
  serviceSuggestions,
  type ServiceCatalogueEntry,
} from "@/domain/service-catalogue";
import { resolveLocalizedText, type LocalizedText } from "@/i18n/localized-text";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { formatBasisPoints, formatDuration, formatMoneyMinor } from "@/lib/format";

/**
 * What goes into `service.name`, which is localized while the form has one box.
 *
 * A catalogue pick carries all three languages, so all three are sent — the one
 * moment a Romanian name gets filled in without anyone typing it. A name the
 * owner typed, or edited after picking, is only theirs in the language they are
 * working in; claiming it as the Romanian name too would be inventing a
 * translation.
 */
export function nameForSubmit(
  typed: string,
  picked: ServiceCatalogueEntry | null,
  locale: AppLocale,
): LocalizedText {
  const trimmed = typed.trim();
  if (picked && resolveLocalizedText(picked.name, locale, locale) === trimmed) {
    return picked.name;
  }
  return { [locale]: trimmed };
}

export type ServiceRow = {
  id: string;
  displayName: string;
  price_minor: number | null;
  duration_minutes: number | null;
  currency: string | null;
  costing:
    | {
        status: "complete";
        contribution_margin_minor: number;
        margin_basis_points: number | null;
        profit_per_hour_minor: number;
      }
    | { status: "incomplete"; reasons: string[] };
};

function IconEdit() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.013 1.427a1.75 1.75 0 0 1 2.474 2.474L4.75 12.639l-3.5.875.875-3.5 8.888-8.587Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4h12M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4m1.5 0-.75 9.5a1 1 0 0 1-1 .917H5.75a1 1 0 0 1-1-.917L4 4"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconX() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

type EditState = {
  id: string;
  name: string;
  price: string;
  duration: string;
};

const cellInput: React.CSSProperties = {
  width: "100%",
  minWidth: "80rem",
  padding: "5rem 8rem",
  borderRadius: "8rem",
  border: "1rem solid var(--line)",
  font: "inherit",
  fontSize: "14rem",
  background: "var(--surface-strong)",
};

export function ServiceList({
  services,
  locale,
}: {
  services: ServiceRow[];
  locale: AppLocale;
}) {
  const t = getTranslator(locale);
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  /*
   * The add-service panel: nothing on the page until the header opens it —
   * the header anchors `app/app/services/page.tsx` renders are the *only*
   * control (`.header-action` on a phone, `.calendar-create` on a desktop; a
   * Server Component, so neither can hold this listener itself, delegated on
   * `document` for that reason). This used to be a `<details>` whose own
   * `<summary>` stayed visible — and clickable — while closed, which put a
   * second «Добавить услугу» directly under the header's own button. A
   * `.compose-wrap` collapsed by class has no such leftover strip.
   */
  // Lazy so it reads the real hash on the client's own first render rather
  // than in a follow-up effect — `location` does not exist during the
  // server's render of this "use client" component.
  const [addOpen, setAddOpen] = useState(() => typeof window !== "undefined" && location.hash === "#add-service");
  const [addName, setAddName] = useState("");
  /**
   * The catalogue entry the name came from, kept so the other two languages can
   * travel with it.
   *
   * Dropped the moment the owner edits the field: once the name is theirs, the
   * Romanian and English of a kind of work they moved away from would be wrong,
   * and a wrong translation is worse than a missing one — the missing one falls
   * back and is visibly absent.
   */
  const [pickedKind, setPickedKind] = useState<ServiceCatalogueEntry | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest('a[href="#add-service"]');
      if (!trigger) return;
      event.preventDefault();
      setAddOpen((open) => !open);
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (addOpen) addRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.querySelectorAll<HTMLAnchorElement>('a.header-action[href="#add-service"]').forEach((button) => {
      const label = addOpen ? button.dataset.labelOpen : button.dataset.labelClosed;
      if (label) button.setAttribute("aria-label", label);
    });
  }, [addOpen]);

  async function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const price = String(data.get("price") ?? "").trim();
    const duration = String(data.get("duration") ?? "").trim();

    const response = await fetch("/api/v1/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // A catalogue pick fills all three languages; a typed name fills the
        // one being worked in, and `resolveLocalizedText` handles the rest.
        name: nameForSubmit(String(data.get("name") ?? ""), pickedKind, locale),
        ...(price ? { price_minor: Math.round(Number(price) * 100) } : {}),
        ...(duration ? { duration_minutes: Number(duration) } : {}),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("services.createFailed"));
      setPending(false);
      return;
    }

    form.reset();
    setAddName("");
    setPickedKind(null);
    setPending(false);
    setAddOpen(false);
    router.refresh();
  }

  function startEdit(service: ServiceRow) {
    setEdit({
      id: service.id,
      name: service.displayName,
      price: service.price_minor !== null ? String(service.price_minor / 100) : "",
      duration: service.duration_minutes !== null ? String(service.duration_minutes) : "",
    });
    setEditError(null);
    setConfirmDeleteId(null);
  }

  function cancelEdit() {
    setEdit(null);
    setEditError(null);
  }

  async function saveEdit() {
    if (!edit) return;
    setEditPending(true);
    setEditError(null);

    const priceVal = edit.price.trim();
    const durationVal = edit.duration.trim();

    const response = await fetch(`/api/v1/services/${edit.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: { [locale]: edit.name.trim() },
        ...(priceVal !== "" ? { price_minor: Math.round(Number(priceVal) * 100) } : { price_minor: null }),
        ...(durationVal !== "" ? { duration_minutes: Number(durationVal) } : { duration_minutes: null }),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setEditError(payload?.error?.message ?? t("services.editFailed"));
      setEditPending(false);
      return;
    }

    setEdit(null);
    setEditPending(false);
    router.refresh();
  }

  async function deleteService(id: string) {
    setDeletePending(true);

    const response = await fetch(`/api/v1/services/${id}`, { method: "DELETE" });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("services.deleteFailed"));
      setDeletePending(false);
      setConfirmDeleteId(null);
      return;
    }

    setConfirmDeleteId(null);
    setDeletePending(false);
    router.refresh();
  }

  const incomplete = services.filter((service) => service.costing.status === "incomplete");

  return (
    <>
      {incomplete.length > 0 && (
        <div className="warning-banner">
          {t("services.incompleteBanner", { count: incomplete.length })}
        </div>
      )}

      <div className={`compose-wrap${addOpen ? "" : " is-closed"}`} id="add-service" ref={addRef}>
        <div className="compose-inner">
          <section className="panel">
            <h2>{t("services.add")}</h2>
            <form className="inline-form" onSubmit={submitAdd}>
              <NameCombobox
                id="service-name"
                name="name"
                label={t("services.name")}
                placeholder={t("services.searchPlaceholder")}
                title={t("services.catalogueTitle")}
                emptyLabel={t("services.noSuggestions")}
                footnote={t("services.customNameHint")}
                required
                maxLength={200}
                value={addName}
                options={serviceSuggestions(addName).map((entry) => ({
                  key: entry.key,
                  label: resolveLocalizedText(entry.name, locale, locale) ?? entry.name.ru,
                }))}
                onChange={(next) => {
                  setAddName(next);
                  setPickedKind(null);
                }}
                onSelect={(option) => {
                  const entry = serviceCatalogue.find((candidate) => candidate.key === option.key);
                  if (!entry) return;
                  setAddName(resolveLocalizedText(entry.name, locale, locale) ?? entry.name.ru);
                  setPickedKind(entry);
                }}
              />
              <label>
                {t("common.price")}
                <input name="price" type="number" step="0.01" min="0" placeholder="600" />
              </label>
              <label>
                {t("services.durationMinutes")}
                <input name="duration" type="number" step="1" min="1" placeholder="90" />
              </label>
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? t("services.creating") : t("services.add")}
              </button>
            </form>
            {error && (
              <div className="form-error" role="alert" style={{ marginTop: "12rem" }}>
                {error}
              </div>
            )}
          </section>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("services.service")}</th>
            <th>{t("common.price")}</th>
            <th>{t("common.duration")}</th>
            <th>{t("services.youKeep")}</th>
            <th>{t("services.margin")}</th>
            <th>{t("services.perHour")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {services.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                {t("services.none")}
              </td>
            </tr>
          )}
          {services.map((service) => {
            const isEditing = edit?.id === service.id;

            if (isEditing) {
              return (
                <tr key={service.id}>
                  {/* Название */}
                  <td>
                    <input
                      aria-label={t("services.service")}
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      maxLength={200}
                      required
                      style={cellInput}
                    />
                  </td>
                  {/* Цена */}
                  <td>
                    <input
                      aria-label={t("common.price")}
                      value={edit.price}
                      onChange={(e) => setEdit({ ...edit, price: e.target.value })}
                      type="number"
                      step="0.01"
                      min="0"
                      style={cellInput}
                    />
                  </td>
                  {/* Длительность */}
                  <td>
                    <input
                      aria-label={t("common.duration")}
                      value={edit.duration}
                      onChange={(e) => setEdit({ ...edit, duration: e.target.value })}
                      type="number"
                      step="1"
                      min="1"
                      style={cellInput}
                    />
                  </td>
                  {/* Расчётные колонки — пусты при редактировании */}
                  <td />
                  <td />
                  {/* Кнопки + ошибка */}
                  <td colSpan={2} style={{ whiteSpace: "nowrap" }}>
                    {editError && (
                      <span style={{ display: "block", color: "var(--danger)", fontSize: "12rem", marginBottom: "4rem" }}>
                        {editError}
                      </span>
                    )}
                    <button
                      className="inline-action"
                      type="button"
                      disabled={editPending || edit.name.trim().length === 0}
                      onClick={saveEdit}
                    >
                      {editPending ? t("common.saving") : t("common.save")}
                    </button>
                    <button
                      className="inline-action"
                      type="button"
                      onClick={cancelEdit}
                      disabled={editPending}
                    >
                      {t("common.cancel")}
                    </button>
                  </td>
                </tr>
              );
            }

            return (
              <tr key={service.id}>
                <td>
                  <Link href={`/app/services/${service.id}`}>{service.displayName}</Link>
                </td>
                <td>
                  {service.price_minor === null
                    ? "—"
                    : formatMoneyMinor(service.price_minor, service.currency ?? "MDL")}
                </td>
                <td>{formatDuration(service.duration_minutes)}</td>
                {service.costing.status === "complete" ? (
                  <>
                    <td className={service.costing.contribution_margin_minor < 0 ? "metric-negative" : ""}>
                      {formatMoneyMinor(
                        service.costing.contribution_margin_minor,
                        service.currency ?? "MDL",
                      )}
                    </td>
                    <td>{formatBasisPoints(service.costing.margin_basis_points)}</td>
                    <td className={service.costing.profit_per_hour_minor < 0 ? "metric-negative" : ""}>
                      {formatMoneyMinor(service.costing.profit_per_hour_minor, service.currency ?? "MDL")}
                    </td>
                  </>
                ) : (
                  <td colSpan={3}>
                    <span className="badge-warning">
                      {t("common.noData")}: {service.costing.reasons.map((r) => t(`reason.${r}` as MessageKey)).join("; ")}
                    </span>
                  </td>
                )}
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    className="inline-action"
                    type="button"
                    onClick={() => startEdit(service)}
                    disabled={deletePending}
                    aria-label={`${t("services.edit")} ${service.displayName}`}
                  >
                    <IconEdit />
                    <span className="btn-label">{t("services.edit")}</span>
                  </button>
                  {confirmDeleteId === service.id ? (
                    <>
                      <button
                        className="inline-action danger"
                        type="button"
                        onClick={() => deleteService(service.id)}
                        disabled={deletePending}
                      >
                        <IconTrash />
                        <span className="btn-label">{t("services.deleteConfirm")}</span>
                      </button>
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={deletePending}
                      >
                        <IconX />
                        <span className="btn-label">{t("common.cancel")}</span>
                      </button>
                    </>
                  ) : (
                    <button
                      className="inline-action danger"
                      type="button"
                      onClick={() => { setConfirmDeleteId(service.id); setEdit(null); }}
                      disabled={deletePending}
                      aria-label={`${t("services.delete")} ${service.displayName}`}
                    >
                      <IconTrash />
                      <span className="btn-label">{t("services.delete")}</span>
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
