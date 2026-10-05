"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { Hint } from "@/components/hint";
import { EffectiveDateField, effectiveDateFrom } from "@/components/effective-date-field";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { localeTag } from "@/i18n/translate";
import { formatBasisPoints } from "@/lib/format";

/**
 * Taxes that attach to a visit.
 *
 * Versioned, like the labour rules: a rate that changed in July must leave June
 * reporting June's, so there is no edit in place. «Изменить с даты» writes the
 * new rate from a day and the endpoint closes the old one at that instant; a
 * tax that stops is a rate of zero from that day. The closed ones stay on
 * screen folded away — they are what past months were costed by.
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
  today,
  asOf,
}: {
  rules: TaxRuleRowView[];
  locale: AppLocale;
  canEdit: boolean;
  /** When the page was read: what «in force» and «still to come» are judged against. */
  asOf: string;
  /** The studio's date, `YYYY-MM-DD`: the first day a rate can change from. */
  today: string;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const rateField = useRef<HTMLInputElement>(null);
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
      const code = body?.error?.code;
      setError(
        code
          ? getErrorMessage(code, body.error.message ?? t("common.saveFailed"), locale, register)
          : t("common.saveFailed"),
      );
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
        ...effectiveDateFrom(data, today),
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

  // In force or still to come, against history — see the same split in
  // `labor-cost-manager.tsx`: a rate changed from a later day is still paid until then.
  const now = Date.parse(asOf);
  const live = rules.filter((rule) => rule.active_to === null || Date.parse(rule.active_to) > now);
  const closed = rules.filter((rule) => rule.active_to !== null && Date.parse(rule.active_to) <= now);
  const dateOf = (iso: string) => new Date(iso).toLocaleDateString(localeCode);

  /** «Изменить с даты» on a row: the form below, already on that tax. */
  function changeFrom(rule: TaxRuleRowView) {
    setKind(rule.kind);
    setError(null);
    rateField.current?.focus();
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
            {t("tax.title")}
          </button>
        )}
      </div>

      <div className={`add-form-wrap${open ? "" : " add-form-closed"}`}>
        <div className="add-form-inner">
          <section className="panel">
            <h2>{t("tax.title")}</h2>
            <Hint
              short={t("tax.hintShort")}
              more={t("tax.hint")}
              moreLabel={t("common.more")}
              howLabel={t("common.howCounted")}
            />

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
                      {Date.parse(rule.active_from) > now
                        ? t("rules.startsOn", { date: dateOf(rule.active_from) })
                        : dateOf(rule.active_from)}
                    </td>
                    <td>
                      {canEdit && (
                        <button
                          className="inline-action"
                          type="button"
                          disabled={pending}
                          onClick={() => changeFrom(rule)}
                        >
                          {t("rules.changeFrom")}
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
                      {t(`tax.kind.${rule.kind}`)}: {describe(rule)} — {dateOf(rule.active_from)} … {dateOf(rule.active_to!)}
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
                  <input
                    ref={rateField}
                    name="rate"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    required
                    placeholder="20"
                  />
                </label>
                {kind === "vat" && (
                  <label className="checkbox-field">
                    <input name="remittable" type="checkbox" defaultChecked /> {t("tax.remittable")}
                  </label>
                )}
                <EffectiveDateField today={today} locale={locale} />
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.save")}
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
