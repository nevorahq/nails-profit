"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { formatMoneyMinor } from "@/lib/format";

export type MaterialRow = {
  id: string;
  name: string;
  base_unit: string;
  current_price: {
    package_price_minor: number;
    package_size_milli_units: number;
    currency: string;
    base_unit_cost_minor: number | null;
  } | null;
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
  unit: string;
  quantity: string;
  price: string;
};

function computeUnitCost(priceStr: string, quantityStr: string): string | null {
  const price = parseFloat(priceStr);
  const qty = parseFloat(quantityStr);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || qty === 0) return null;
  return (price / qty).toFixed(2);
}

export function MaterialCatalogue({
  materials,
  locale,
}: {
  materials: MaterialRow[];
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  async function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);

    const price = String(data.get("price") ?? "").trim();
    const size = String(data.get("size") ?? "").trim();

    const response = await fetch("/api/v1/materials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        base_unit: data.get("base_unit"),
        ...(price && size
          ? { package_price_minor: Math.round(Number(price) * 100), package_size: Number(size) }
          : {}),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("materials.saveFailed"));
      setPending(false);
      return;
    }

    form.reset();
    setPending(false);
    router.refresh();
  }

  function startEdit(material: MaterialRow) {
    setEdit({
      id: material.id,
      name: material.name,
      unit: material.base_unit,
      quantity: material.current_price
        ? String(material.current_price.package_size_milli_units / 1000)
        : "",
      price: material.current_price
        ? String(material.current_price.package_price_minor / 100)
        : "",
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

    // Always update name / unit
    const patchRes = await fetch(`/api/v1/materials/${edit.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: edit.name.trim(), base_unit: edit.unit }),
    });

    if (!patchRes.ok) {
      const payload = await patchRes.json().catch(() => null);
      setEditError(payload?.error?.message ?? t("materials.editFailed"));
      setEditPending(false);
      return;
    }

    // Record a new price version only when both fields are filled
    const priceVal = edit.price.trim();
    const qtyVal = edit.quantity.trim();
    if (priceVal && qtyVal) {
      const priceRes = await fetch(`/api/v1/materials/${edit.id}/prices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package_price_minor: Math.round(Number(priceVal) * 100),
          package_size: Number(qtyVal),
        }),
      });

      if (!priceRes.ok) {
        const payload = await priceRes.json().catch(() => null);
        setEditError(payload?.error?.message ?? t("materials.editFailed"));
        setEditPending(false);
        return;
      }
    }

    setEdit(null);
    setEditPending(false);
    router.refresh();
  }

  async function deleteMaterial(id: string) {
    setDeletePending(true);

    const response = await fetch(`/api/v1/materials/${id}`, { method: "DELETE" });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("materials.deleteFailed"));
      setDeletePending(false);
      setConfirmDeleteId(null);
      return;
    }

    setConfirmDeleteId(null);
    setDeletePending(false);
    router.refresh();
  }

  const missingPrice = materials.filter((m) => m.current_price === null).length;

  // Preview unit cost while editing
  const editUnitCost =
    edit ? computeUnitCost(edit.price, edit.quantity) : null;

  return (
    <>
      {missingPrice > 0 && (
        <div className="warning-banner">
          {t("materials.missingPriceBanner", { count: missingPrice })}
        </div>
      )}

      {/* Mobile toggle — hidden on desktop via CSS */}
      <div className="add-form-toggle">
        {formOpen ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn-toggle-close"
              type="button"
              onClick={() => setFormOpen(false)}
              aria-label={t("common.cancel")}
            >
              −
            </button>
          </div>
        ) : (
          <button
            className="primary-button"
            type="button"
            style={{ width: "100%" }}
            onClick={() => setFormOpen(true)}
          >
            {t("materials.addMaterial")}
          </button>
        )}
      </div>

      {/* Collapsible on mobile; always visible on desktop */}
      <div className={`add-form-wrap${formOpen ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
          <form className="inline-form" onSubmit={submitAdd}>
            <label>
              {t("materials.name")}
              <input name="name" required maxLength={200} placeholder={t("materials.namePlaceholder")} />
            </label>
            <label>
              {t("materials.unit")}
              <select name="base_unit" defaultValue="ml">
                <option value="ml">{t("unit.ml")}</option>
                <option value="g">{t("unit.g")}</option>
                <option value="piece">{t("unit.piece")}</option>
              </select>
            </label>
            <label>
              {t("materials.packagePrice")}
              <input name="price" type="number" step="0.01" min="0" placeholder="240" />
            </label>
            <label>
              {t("materials.packageSize")}
              <input name="size" type="number" step="0.001" min="0" placeholder="15" />
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("common.add")}
            </button>
          </form>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("common.material")}</th>
            <th>{t("materials.quantity")}</th>
            <th>{t("materials.unit")}</th>
            <th>{t("materials.packagePrice")}</th>
            <th>{t("materials.unitCost")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {materials.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t("materials.none")}
              </td>
            </tr>
          )}
          {materials.map((material) => {
            const isEditing = edit?.id === material.id;

            if (isEditing) {
              return (
                <tr key={material.id}>
                  {/* Материал */}
                  <td>
                    <input
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      maxLength={200}
                      required
                      style={cellInputStyle}
                    />
                  </td>
                  {/* Количество */}
                  <td>
                    <input
                      value={edit.quantity}
                      onChange={(e) => setEdit({ ...edit, quantity: e.target.value })}
                      type="number"
                      step="0.001"
                      min="0"
                      style={cellInputStyle}
                    />
                  </td>
                  {/* Единица */}
                  <td>
                    <select
                      value={edit.unit}
                      onChange={(e) => setEdit({ ...edit, unit: e.target.value })}
                      style={cellInputStyle}
                    >
                      <option value="ml">{t("unit.ml")}</option>
                      <option value="g">{t("unit.g")}</option>
                      <option value="piece">{t("unit.piece")}</option>
                    </select>
                  </td>
                  {/* Цена упаковки */}
                  <td>
                    <input
                      value={edit.price}
                      onChange={(e) => setEdit({ ...edit, price: e.target.value })}
                      type="number"
                      step="0.01"
                      min="0"
                      style={cellInputStyle}
                    />
                  </td>
                  {/* Цена за единицу — расчётная, только чтение */}
                  <td className="muted">
                    {editUnitCost !== null
                      ? `${editUnitCost} / ${t(`unit.${edit.unit}` as never)}`
                      : "—"}
                  </td>
                  {/* Действия */}
                  <td style={{ whiteSpace: "nowrap" }}>
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

            const pkg = material.current_price;

            return (
              <tr key={material.id}>
                <td>{material.name}</td>
                <td>
                  {pkg ? String(pkg.package_size_milli_units / 1000) : "—"}
                </td>
                <td>{t(`unit.${material.base_unit}` as never)}</td>
                <td>
                  {pkg
                    ? formatMoneyMinor(pkg.package_price_minor, pkg.currency)
                    : <span className="badge-warning">{t("materials.priceMissing")}</span>}
                </td>
                <td>
                  {pkg?.base_unit_cost_minor != null
                    ? `${formatMoneyMinor(pkg.base_unit_cost_minor, pkg.currency)} / ${material.base_unit}`
                    : "—"}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    className="inline-action"
                    type="button"
                    onClick={() => startEdit(material)}
                    disabled={deletePending}
                    aria-label={`${t("materials.edit")} ${material.name}`}
                  >
                    <IconEdit />
                    <span className="btn-label">{t("materials.edit")}</span>
                  </button>
                  {confirmDeleteId === material.id ? (
                    <>
                      <button
                        className="inline-action danger"
                        type="button"
                        onClick={() => deleteMaterial(material.id)}
                        disabled={deletePending}
                      >
                        <IconTrash />
                        <span className="btn-label">{t("materials.deleteConfirm")}</span>
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
                      onClick={() => { setConfirmDeleteId(material.id); setEdit(null); }}
                      disabled={deletePending}
                      aria-label={`${t("materials.delete")} ${material.name}`}
                    >
                      <IconTrash />
                      <span className="btn-label">{t("materials.delete")}</span>
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

const cellInputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: "80rem",
  padding: "5rem 8rem",
  borderRadius: "8rem",
  border: "1rem solid var(--line)",
  font: "inherit",
  fontSize: "14rem",
  background: "var(--surface-strong)",
};
