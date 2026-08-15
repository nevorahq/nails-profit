"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

/**
 * How the studio takes money, and what that costs.
 *
 * The default method is the whole feature. The acquirer's fee is only counted
 * when someone says the client paid by card, and nobody will remember to say it
 * every time — so the right answer is the one already selected on the closing
 * form, and the exception is what gets typed.
 *
 * Editable in place, unlike the labour and tax rules beside it: those are
 * resolved for the date a visit closed, so editing one would rewrite a past
 * month, while this rate is copied into each visit and never read again. A new
 * contract with the bank changes what the studio pays from now on, which is
 * what an edit means.
 */
export type PaymentMethodRow = {
  id: string;
  name: string;
  kind: "cash" | "card" | "transfer" | "other";
  commission_basis_points: number;
  fixed_fee_minor: number;
  is_default: boolean;
};

const kinds = ["cash", "card", "transfer", "other"] as const;

export function PaymentMethodManager({
  methods,
  currency,
  locale,
  canEdit,
}: {
  methods: PaymentMethodRow[];
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
    const rate = Number(String(data.get("rate") ?? "0").trim()) || 0;
    const fee = Number(String(data.get("fee") ?? "0").trim()) || 0;

    const ok = await send(
      "/api/v1/payment-methods",
      {
        name: String(data.get("name") ?? "").trim(),
        kind: String(data.get("kind") ?? "card"),
        commission_basis_points: Math.round(rate * 100),
        fixed_fee_minor: Math.round(fee * 100),
        is_default: data.get("is_default") === "on",
      },
      "POST",
      form,
    );
    if (ok) setOpen(false);
  }

  function describe(method: PaymentMethodRow) {
    if (method.commission_basis_points === 0 && method.fixed_fee_minor === 0) {
      return t("payment.noFee");
    }
    const parts = [];
    if (method.commission_basis_points > 0) {
      parts.push(formatBasisPoints(method.commission_basis_points, localeCode));
    }
    if (method.fixed_fee_minor > 0) {
      parts.push(formatMoneyMinor(method.fixed_fee_minor, currency, localeCode));
    }
    return parts.join(" + ");
  }

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
            {t("payment.title")}
          </button>
        )}
      </div>

      <div className={`add-form-wrap${open ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
          <section className="panel">
            <h2>{t("payment.title")}</h2>
            <p className="muted">{t("payment.hint")}</p>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <table className="data-table pl-table labor-table">
              <thead>
                <tr>
                  <th>{t("payment.name")}</th>
                  <th>{t("payment.fee")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {methods.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      {t("payment.none")}
                    </td>
                  </tr>
                )}
                {methods.map((method) => (
                  <tr key={method.id}>
                    <td>
                      {method.name}
                      {method.is_default && <span className="badge-accent">{t("payment.default")}</span>}
                    </td>
                    <td>{describe(method)}</td>
                    <td className="pl-actions">
                      {canEdit && (
                        <>
                          {!method.is_default && (
                            <button
                              className="inline-action"
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                send(`/api/v1/payment-methods/${method.id}`, { is_default: true }, "PATCH")
                              }
                            >
                              {t("payment.setDefault")}
                            </button>
                          )}
                          <button
                            className="inline-action danger"
                            type="button"
                            disabled={pending}
                            onClick={() => send(`/api/v1/payment-methods/${method.id}`, null, "DELETE")}
                          >
                            {t("payment.archive")}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {canEdit && (
              <form className="inline-form" onSubmit={add}>
                <label>
                  {t("payment.name")}
                  <input name="name" required maxLength={100} placeholder={t("payment.namePlaceholder")} />
                </label>
                <label>
                  {t("payment.kind")}
                  <select name="kind" defaultValue="card">
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`payment.kind.${kind}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("payment.rate")}
                  <input name="rate" type="number" step="0.01" min="0" placeholder="2.2" />
                </label>
                <label>
                  {t("payment.fixedFee", { currency })}
                  <input name="fee" type="number" step="0.01" min="0" placeholder="0" />
                </label>
                <label className="checkbox-field">
                  <input name="is_default" type="checkbox" /> {t("payment.makeDefault")}
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
