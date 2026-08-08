"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";

export type ClientRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  anonymized: boolean;
  visitCount: number;
  lastVisitAt: Date | string | null;
  totalSpent: string | null;
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
  phone: string;
  email: string;
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

export function ClientManager({
  clients,
  canWrite,
  locale,
}: {
  clients: ClientRow[];
  canWrite: boolean;
  currency: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const tag = localeTag(locale);

  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const body: Record<string, string> = { name: String(data.get("name") ?? "").trim() };
    const phone = String(data.get("phone") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    if (phone) body.phone = phone;
    if (email) body.email = email;

    const response = await fetch("/api/v1/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("clients.addFailed"));
      return;
    }

    form.reset();
    setAddOpen(false);
    router.refresh();
  }

  async function save() {
    if (!edit) return;
    setEditPending(true);
    setEditError(null);

    const body: Record<string, string | null> = { name: edit.name.trim() };
    body.phone = edit.phone.trim() || null;
    body.email = edit.email.trim() || null;

    const response = await fetch(`/api/v1/clients/${edit.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    setEditPending(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setEditError(payload?.error?.message ?? t("clients.editFailed"));
      return;
    }

    setEdit(null);
    router.refresh();
  }

  async function deleteClient(client: ClientRow) {
    if (!confirm(t("clients.deleteConfirm", { name: client.name }))) return;
    setDeletingId(client.id);

    const response = await fetch(`/api/v1/clients/${client.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    setDeletingId(null);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("clients.deleteFailed"));
      return;
    }

    router.refresh();
  }

  function formatDate(date: Date | string | null): string {
    if (!date) return t("clients.never");
    return new Date(date).toLocaleDateString(tag);
  }

  const colSpan = canWrite ? 7 : 6;

  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t("clients.name")}</th>
            <th>{t("clients.phone")}</th>
            <th>{t("clients.email")}</th>
            <th>{t("clients.lastVisit")}</th>
            <th>{t("clients.visitCount")}</th>
            <th>{t("clients.totalSpent")}</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {clients.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="muted">
                {t("clients.none")}
              </td>
            </tr>
          )}
          {clients.map((client) => {
            const isEditing = edit?.id === client.id;
            return (
              <tr
                key={client.id}
                onClick={() => {
                  if (!isEditing && !client.anonymized) router.push(`/app/clients/${client.id}`);
                }}
                style={!isEditing && !client.anonymized ? { cursor: "pointer" } : undefined}
              >
                <td>
                  {client.anonymized ? (
                    <span className="muted">{t("clients.anonymized")}</span>
                  ) : isEditing ? (
                    <input
                      style={cellInput}
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      maxLength={200}
                    />
                  ) : (
                    client.name
                  )}
                </td>
                <td className="muted">
                  {isEditing ? (
                    <input
                      style={cellInput}
                      value={edit.phone}
                      onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
                      type="tel"
                      placeholder={t("clients.phonePlaceholder")}
                    />
                  ) : (
                    client.phone ?? "—"
                  )}
                </td>
                <td className="muted">
                  {isEditing ? (
                    <input
                      style={cellInput}
                      value={edit.email}
                      onChange={(e) => setEdit({ ...edit, email: e.target.value })}
                      type="email"
                      placeholder="client@example.com"
                    />
                  ) : (
                    client.email ?? "—"
                  )}
                </td>
                <td className="muted">{formatDate(client.lastVisitAt)}</td>
                <td>{client.visitCount > 0 ? client.visitCount : <span className="muted">0</span>}</td>
                <td>{client.totalSpent ?? <span className="muted">—</span>}</td>
                {canWrite && (
                  <td onClick={(e) => e.stopPropagation()}>
                    {client.anonymized ? null : isEditing ? (
                      <div className="inline-actions">
                        <button
                          className="inline-action"
                          type="button"
                          onClick={save}
                          disabled={editPending || !edit.name.trim()}
                        >
                          {editPending ? t("common.saving") : t("common.save")}
                        </button>
                        <button
                          className="inline-action"
                          type="button"
                          onClick={() => { setEdit(null); setEditError(null); }}
                        >
                          <IconX />
                          <span className="btn-label">{t("common.cancel")}</span>
                        </button>
                        {editError && (
                          <span style={{ fontSize: "12rem", color: "var(--danger)" }}>
                            {editError}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="inline-actions">
                        <button
                          className="inline-action"
                          type="button"
                          onClick={() => setEdit({
                            id: client.id,
                            name: client.name,
                            phone: client.phone ?? "",
                            email: client.email ?? "",
                          })}
                          aria-label={t("services.edit")}
                        >
                          <IconEdit />
                          <span className="btn-label">{t("services.edit")}</span>
                        </button>
                        <button
                          className="inline-action danger"
                          type="button"
                          onClick={() => deleteClient(client)}
                          disabled={deletingId === client.id}
                          aria-label={t("common.delete")}
                        >
                          <IconTrash />
                          <span className="btn-label">{t("common.delete")}</span>
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {canWrite && (
        <>
          <div className="add-form-toggle">
            {addOpen ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="btn-toggle-close"
                  type="button"
                  onClick={() => { setAddOpen(false); setError(null); }}
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
                onClick={() => setAddOpen(true)}
              >
                {t("clients.addTitle")}
              </button>
            )}
          </div>
          <div className={`add-form-wrap${addOpen ? "" : " add-form-closed"}`}>
            <div className="add-form-inner">
              <section className="panel">
                <h2>{t("clients.addTitle")}</h2>
                <form className="inline-form" onSubmit={add}>
                  <label>
                    {t("clients.name")}
                    <input
                      name="name"
                      required
                      minLength={1}
                      maxLength={200}
                      placeholder={t("clients.namePlaceholder")}
                    />
                  </label>
                  <label>
                    {t("clients.phone")}
                    <input
                      name="phone"
                      type="tel"
                      placeholder={t("clients.phonePlaceholder")}
                    />
                  </label>
                  <label>
                    {t("clients.email")}
                    <input name="email" type="email" placeholder="client@example.com" />
                  </label>
                  <button className="primary-button" type="submit" disabled={pending}>
                    {pending ? t("common.saving") : t("clients.addButton")}
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
        </>
      )}
    </>
  );
}
