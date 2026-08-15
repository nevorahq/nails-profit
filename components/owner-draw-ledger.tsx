"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatMoneyMinor } from "@/lib/format";

/**
 * Money the owner took out for themselves.
 *
 * Beside the expense ledger and deliberately not inside it. A draw is not a
 * cost: it does not reduce the profit that pays for it, and filing it under
 * `payroll` — which is what an owner does when there is nowhere else to put it
 * — either shrinks that profit or disappears into the class the report shows
 * but never subtracts. Here it lands in exactly one statement, the cash flow.
 */
export type OwnerDrawRow = {
  id: string;
  amount_minor: number;
  currency: string;
  occurred_on: string;
  note: string | null;
};

export function OwnerDrawLedger({
  draws,
  currency,
  locale,
  canEdit,
}: {
  draws: OwnerDrawRow[];
  currency: string;
  locale: AppLocale;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const localeCode = localeTag(locale);

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, payload: unknown, method = "POST", form?: HTMLFormElement) {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: payload === null ? undefined : { "content-type": "application/json" },
      body: payload === null ? undefined : JSON.stringify(payload),
    });
    setPending(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("common.saveFailed"));
      return false;
    }
    form?.reset();
    router.refresh();
    return true;
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const amount = Number(String(data.get("amount") ?? "").trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(t("draws.amountRequired"));
      return;
    }

    const occurredOn = String(data.get("occurred_on") ?? "").trim();
    const ok = await send(
      "/api/v1/owner-draws",
      {
        amount_minor: Math.round(amount * 100),
        currency,
        ...(occurredOn ? { occurred_on: occurredOn } : {}),
        note: String(data.get("note") ?? "").trim() || undefined,
      },
      "POST",
      form,
    );
    if (ok) setOpen(false);
  }

  const total = draws
    .filter((draw) => draw.currency === currency)
    .reduce((sum, draw) => sum + draw.amount_minor, 0);

  return (
    <>
      <div className="add-form-toggle">
        {open ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn-toggle-close"
              type="button"
              onClick={() => setOpen(false)}
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
            onClick={() => setOpen(true)}
          >
            {t("draws.title")}
          </button>
        )}
      </div>

      <div className={`add-form-wrap${open ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
          <section className="panel">
            <h2>{t("draws.title")}</h2>
            <p className="muted">{t("draws.hint")}</p>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <table className="data-table pl-table labor-table">
              <thead>
                <tr>
                  <th className="labor-since">{t("draws.day")}</th>
                  <th>{t("draws.note")}</th>
                  <th>{t("draws.amount", { currency })}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draws.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {t("draws.none")}
                    </td>
                  </tr>
                )}
                {draws.map((draw) => (
                  <tr key={draw.id}>
                    <td className="labor-since">
                      {new Date(`${draw.occurred_on}T00:00:00.000Z`).toLocaleDateString(localeCode)}
                    </td>
                    <td>{draw.note ?? <span className="muted">—</span>}</td>
                    <td>{formatMoneyMinor(draw.amount_minor, draw.currency, localeCode)}</td>
                    <td className="pl-actions">
                      {canEdit && (
                        <button
                          className="inline-action danger"
                          type="button"
                          disabled={pending}
                          onClick={() => send(`/api/v1/owner-draws?id=${draw.id}`, null, "DELETE")}
                        >
                          {t("common.delete")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {draws.length > 0 && (
                <tfoot>
                  {/* The total sits in the amount column, not spanning it and
                      the actions: spanning both right-aligns it over the panel
                      edge, out of line with every figure above it. */}
                  <tr>
                    <td colSpan={2}>{t("expenses.total")}</td>
                    <td>
                      <strong>{formatMoneyMinor(total, currency, localeCode)}</strong>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>

            {canEdit && (
              <form className="inline-form" onSubmit={add}>
                <label>
                  {t("draws.amount", { currency })}
                  <input name="amount" type="number" step="0.01" min="0" required placeholder="5000" />
                </label>
                <label>
                  {t("draws.day")}
                  <input name="occurred_on" type="date" />
                </label>
                <label>
                  {t("draws.note")}
                  <input name="note" maxLength={500} placeholder={t("draws.notePlaceholder")} />
                </label>
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.add")}
                </button>
              </form>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
