"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints } from "@/lib/format";

/**
 * Taxes that attach to a visit.
 *
 * Versioned, like the labour rules: there is no «изменить», because a rate that
 * changed in July must leave June reporting June's. A new rate closes the old
 * one, and the closed ones stay on screen folded away — they are what past
 * months were costed by.
 *
 * A fixed monthly payment is not entered here. It belongs in the expense ledger
 * as a recurring row, and having two places to enter the same money is how a
 * sum gets subtracted twice.
 */
export type TaxRuleRowView = {
  id: string;
  kind: "vat" | "turnover" | "payroll";
  basis_points: number;
  remittable: boolean;
  active_from: string;
  active_to: string | null;
};

const kinds = ["vat", "turnover", "payroll"] as const;

export function TaxRuleManager({
  rules,
  locale,
  canEdit,
}: {
  rules: TaxRuleRowView[];
  locale: AppLocale;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const localeCode = localeTag(locale);

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof kinds)[number]>("vat");

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
    const rate = Number(String(data.get("rate") ?? "").trim());
    if (!Number.isFinite(rate)) {
      setError(t("tax.rateRequired"));
      return;
    }

    const ok = await send(
      "/api/v1/tax-rules",
      {
        kind,
        basis_points: Math.round(rate * 100),
        // Only VAT is ever handed on; for the other two the flag has no meaning
        // and the server stores its default.
        ...(kind === "vat" ? { remittable: data.get("remittable") === "on" } : {}),
      },
      "POST",
      form,
    );
    if (ok) setOpen(false);
  }

  function describe(rule: TaxRuleRowView) {
    const rate = formatBasisPoints(rule.basis_points, localeCode);
    return rule.kind === "vat" && !rule.remittable ? `${rate} · ${t("tax.notRemitted")}` : rate;
  }

  const live = rules.filter((rule) => rule.active_to === null);
  const closed = rules.filter((rule) => rule.active_to !== null);

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
            {t("tax.title")}
          </button>
        )}
      </div>

      <div className={`add-form-wrap${open ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
          <section className="panel">
            <h2>{t("tax.title")}</h2>
            <p className="muted">{t("tax.hint")}</p>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <table className="data-table pl-table labor-table">
              <thead>
                <tr>
                  <th>{t("tax.kind")}</th>
                  <th>{t("tax.rate")}</th>
                  <th className="labor-since">{t("labor.since")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {live.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {t("tax.none")}
                    </td>
                  </tr>
                )}
                {live.map((rule) => (
                  <tr key={rule.id}>
                    <td>{t(`tax.kind.${rule.kind}`)}</td>
                    <td>{describe(rule)}</td>
                    <td className="labor-since">
                      {new Date(rule.active_from).toLocaleDateString(localeCode)}
                    </td>
                    <td>
                      {canEdit && (
                        <button
                          className="inline-action danger"
                          type="button"
                          disabled={pending}
                          onClick={() => send(`/api/v1/tax-rules/${rule.id}`, null, "DELETE")}
                        >
                          {t("labor.close")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {closed.length > 0 && (
              <details className="pl-history">
                <summary>{t("labor.historyTitle", { count: closed.length })}</summary>
                <ul className="compact-list">
                  {closed.map((rule) => (
                    <li key={rule.id}>
                      {t(`tax.kind.${rule.kind}`)}: {describe(rule)} —{" "}
                      {new Date(rule.active_from).toLocaleDateString(localeCode)} …{" "}
                      {new Date(rule.active_to!).toLocaleDateString(localeCode)}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {canEdit && (
              <form className="inline-form" onSubmit={add}>
                <label>
                  {t("tax.kind")}
                  <select
                    name="kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as (typeof kinds)[number])}
                  >
                    {kinds.map((option) => (
                      <option key={option} value={option}>
                        {t(`tax.kind.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("tax.rate")}
                  <input name="rate" type="number" step="0.01" min="0" max="100" required placeholder="20" />
                </label>
                {kind === "vat" && (
                  <label className="checkbox-field">
                    <input name="remittable" type="checkbox" defaultChecked /> {t("tax.remittable")}
                  </label>
                )}
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.add")}
                </button>
              </form>
            )}
            <p className="muted">{t(`tax.hint.${kind}`)}</p>
          </section>
        </div>
      </div>
    </>
  );
}
