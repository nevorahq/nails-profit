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

export function ClientManager({
  clients,
  canWrite,
  canAnonymize,
  locale,
}: {
  clients: ClientRow[];
  canWrite: boolean;
  canAnonymize: boolean;
  currency: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const tag = localeTag(locale);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anonymizingId, setAnonymizingId] = useState<string | null>(null);

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
    router.refresh();
  }

  async function anonymize(client: ClientRow) {
    if (!confirm(t("clients.anonymizeConfirm", { name: client.name }))) return;
    setAnonymizingId(client.id);

    const response = await fetch(`/api/v1/clients/${client.id}`, { method: "DELETE" });
    setAnonymizingId(null);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("clients.anonymizeFailed"));
      return;
    }

    router.refresh();
  }

  function formatDate(date: Date | string | null): string {
    if (!date) return t("clients.never");
    return new Date(date).toLocaleDateString(tag);
  }

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
            {canAnonymize && <th />}
          </tr>
        </thead>
        <tbody>
          {clients.length === 0 && (
            <tr>
              <td colSpan={canAnonymize ? 7 : 6} className="muted">
                {t("clients.none")}
              </td>
            </tr>
          )}
          {clients.map((client) => (
            <tr key={client.id}>
              <td>
                {client.anonymized ? (
                  <span className="muted">{t("clients.anonymized")}</span>
                ) : (
                  client.name
                )}
              </td>
              <td className="muted">{client.phone ?? "—"}</td>
              <td className="muted">{client.email ?? "—"}</td>
              <td className="muted">{formatDate(client.lastVisitAt)}</td>
              <td>{client.visitCount > 0 ? client.visitCount : <span className="muted">0</span>}</td>
              <td>{client.totalSpent ?? <span className="muted">—</span>}</td>
              {canAnonymize && (
                <td>
                  {!client.anonymized && (
                    <div className="inline-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => anonymize(client)}
                        disabled={anonymizingId === client.id}
                        style={{ fontSize: "12rem" }}
                      >
                        {t("clients.anonymizeButton")}
                      </button>
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {canWrite && (
        <section className="panel" style={{ marginTop: "24rem" }}>
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
              {pending ? "…" : t("clients.addButton")}
            </button>
          </form>
          {error && (
            <div className="form-error" role="alert" style={{ marginTop: "12rem" }}>
              {error}
            </div>
          )}
        </section>
      )}
    </>
  );
}
