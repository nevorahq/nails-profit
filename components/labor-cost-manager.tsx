"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

/**
 * Wages the month owes and no visit does.
 *
 * Two arrangements through one form, because they are one mechanism: a master
 * on a salary, and what the owner's own work is worth. The difference is only
 * which side of the operating profit the answer lands on, and the report says
 * that — this screen just collects the numbers.
 *
 * There is no edit. A rule is closed and a new one written, because a month
 * already reported has to keep the salary that was true in it; the API works
 * the same way, so «изменить» here would be a lie about what the button does.
 */
export type LaborCostRow = {
  id: string;
  recipient: "owner" | "specialist";
  specialist_id: string | null;
  label: string | null;
  basis: "fixed_monthly" | "percent_revenue";
  amount_minor: number | null;
  basis_points: number | null;
  payroll_tax_basis_points: number;
  active_from: string;
  active_to: string | null;
};

export function LaborCostManager({
  rules,
  specialists,
  currency,
  locale,
  businessType,
  reserveMinor,
  canEdit,
  suggestedOwnerWageMinor,
}: {
  rules: LaborCostRow[];
  specialists: { id: string; name: string }[];
  currency: string;
  locale: AppLocale;
  businessType: BusinessType;
  reserveMinor: number;
  canEdit: boolean;
  /**
   * What the owner already booked themselves this month at the market rate.
   * Offered as the starting value, because it is the number they would
   * otherwise have to work out by hand — and the one that makes the add-back
   * and the wage cancel exactly.
   */
  suggestedOwnerWageMinor: number;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<"owner" | "specialist">("owner");
  const [basis, setBasis] = useState<"fixed_monthly" | "percent_revenue">("fixed_monthly");
  const [reserve, setReserve] = useState(String(reserveMinor / 100));

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

  async function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = Number(String(data.get("value") ?? "").trim());
    if (!Number.isFinite(value)) {
      setError(t("labor.valueRequired"));
      return;
    }
    const tax = Number(String(data.get("payroll_tax") ?? "0").trim()) || 0;

    const ok = await send("/api/v1/labor-costs", {
      recipient,
      ...(recipient === "specialist" ? { specialist_id: data.get("specialist_id") } : {}),
      label: String(data.get("label") ?? "").trim() || undefined,
      basis,
      ...(basis === "fixed_monthly"
        ? { amount_minor: Math.round(value * 100) }
        : { basis_points: Math.round(value * 100) }),
      payroll_tax_basis_points: Math.round(tax * 100),
    });
    if (ok) setOpen(false);
  }

  function describe(rule: LaborCostRow) {
    const base =
      rule.basis === "fixed_monthly"
        ? t("labor.perMonth", { amount: money(rule.amount_minor ?? 0) })
        : t("labor.ofRevenue", { rate: formatBasisPoints(rule.basis_points, localeCode) });
    return rule.payroll_tax_basis_points > 0
      ? `${base} + ${formatBasisPoints(rule.payroll_tax_basis_points, localeCode)} ${t("labor.payrollTaxShort")}`
      : base;
  }

  function nameOf(rule: LaborCostRow) {
    if (rule.recipient === "owner") return t(businessLabel.ownerWage[businessType]);
    return specialists.find((person) => person.id === rule.specialist_id)?.name ?? rule.label ?? "—";
  }

  const live = rules.filter((rule) => rule.active_to === null);
  const closed = rules.filter((rule) => rule.active_to !== null);

  return (
    <>
      <div className="add-form-toggle">
        {open ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn-toggle-close" type="button" onClick={() => setOpen(false)} aria-label={t("common.cancel")}>
              −
            </button>
          </div>
        ) : (
          <button className="primary-button" type="button" style={{ width: "100%" }} onClick={() => setOpen(true)}>
            {t("labor.title")}
          </button>
        )}
      </div>

      <div className={`add-form-wrap${open ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
          <section className="panel">
            <h2>{t("labor.title")}</h2>
            <p className="muted">{t("labor.hint")}</p>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <table className="data-table pl-table labor-table">
              <thead>
                <tr>
                  <th>{t("labor.who")}</th>
                  <th>{t("labor.arrangement")}</th>
                  <th className="labor-since">{t("labor.since")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {live.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {t("labor.none")}
                    </td>
                  </tr>
                )}
                {live.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      {nameOf(rule)}
                      {rule.recipient === "owner" && <span className="badge-accent">{t("specialists.principal")}</span>}
                    </td>
                    <td>{describe(rule)}</td>
                    <td className="labor-since">{new Date(rule.active_from).toLocaleDateString(localeCode)}</td>
                    <td>
                      {canEdit && (
                        <button
                          className="inline-action danger"
                          type="button"
                          disabled={pending}
                          onClick={() => send(`/api/v1/labor-costs/${rule.id}`, null, "DELETE")}
                        >
                          {t("labor.close")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/*
              Superseded rules stay on screen rather than vanishing. They are
              what a past month is still costed by, and an owner comparing
              March with October needs to be able to see that the salary
              changed in June.
            */}
            {closed.length > 0 && (
              <details className="pl-history">
                <summary>{t("labor.historyTitle", { count: closed.length })}</summary>
                <ul className="compact-list">
                  {closed.map((rule) => (
                    <li key={rule.id}>
                      {nameOf(rule)}: {describe(rule)} —{" "}
                      {new Date(rule.active_from).toLocaleDateString(localeCode)} …{" "}
                      {new Date(rule.active_to!).toLocaleDateString(localeCode)}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {canEdit && (
              <form className="inline-form" onSubmit={addRule}>
                <label>
                  {t("labor.who")}
                  <select
                    name="recipient"
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value as "owner" | "specialist")}
                  >
                    <option value="owner">{t(businessLabel.ownerWage[businessType])}</option>
                    <option value="specialist">{t("labor.recipientSpecialist")}</option>
                  </select>
                </label>

                {recipient === "specialist" && (
                  <label>
                    {t("specialists.specialist")}
                    <select name="specialist_id" required>
                      {specialists.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label>
                  {t("labor.basis")}
                  <select
                    name="basis"
                    value={basis}
                    onChange={(event) => setBasis(event.target.value as "fixed_monthly" | "percent_revenue")}
                  >
                    <option value="fixed_monthly">{t("labor.basisFixed")}</option>
                    <option value="percent_revenue">{t("labor.basisPercent")}</option>
                  </select>
                </label>

                <label>
                  {basis === "fixed_monthly" ? t("labor.amount", { currency }) : t("labor.rate")}
                  <input
                    name="value"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={
                      recipient === "owner" && basis === "fixed_monthly" && suggestedOwnerWageMinor > 0
                        ? String(suggestedOwnerWageMinor / 100)
                        : ""
                    }
                    placeholder={basis === "fixed_monthly" ? "15000" : "30"}
                  />
                </label>

                <label>
                  {t("labor.payrollTax")}
                  <input name="payroll_tax" type="number" step="0.01" min="0" placeholder="0" />
                </label>

                <label>
                  {t("labor.label")}
                  <input name="label" maxLength={200} placeholder={t("labor.labelPlaceholder")} />
                </label>

                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.add")}
                </button>
              </form>
            )}

            {/*
              The suggestion, spelled out beside the field rather than only
              pre-filled: an owner who does not know where 15 000 came from will
              not trust the economic profit it produces.
            */}
            {canEdit && recipient === "owner" && suggestedOwnerWageMinor > 0 && (
              <p className="muted">{t("labor.suggestedHint", { amount: money(suggestedOwnerWageMinor) })}</p>
            )}

            {canEdit && (
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(
                    "/api/v1/organizations/settings",
                    { withdrawal_reserve_minor: Math.round((Number(reserve) || 0) * 100) },
                    "PATCH",
                  );
                }}
              >
                <label>
                  {t("labor.reserve", { currency })}
                  <input
                    value={reserve}
                    type="number"
                    step="0.01"
                    min="0"
                    onChange={(event) => setReserve(event.target.value)}
                  />
                </label>
                <button className="secondary-button" type="submit" disabled={pending}>
                  {t("common.save")}
                </button>
              </form>
            )}
            <p className="muted">{t("labor.reserveHint")}</p>
          </section>
        </div>
      </div>
    </>
  );
}
