"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import { Hint } from "@/components/hint";
import { EffectiveDateField, effectiveDateFrom } from "@/components/effective-date-field";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
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
 * For a studio of one it is one arrangement, and the form says so: no «Кому»,
 * no picker, and a paragraph that does not open by distinguishing her wage
 * from a salary nobody draws. What it collects is the same rule, and it is the
 * one this whole screen exists for — `ownerWageMinor` is the line under the
 * operating profit in `domain/period-pl.ts` and the second break-even in
 * `domain/capacity.ts`, which is the question «заплатила ли я себе» in a
 * number. Without a rule here that number does not exist.
 *
 * There is no edit in place. A month already reported has to keep the salary
 * that was true in it, so a change is a new rule from a day — «Изменить с
 * даты» — and the endpoint closes the old one at that same instant. Stopping a
 * wage is the same act with zero in it; there is no separate «Завершить», whose
 * second half (writing the new rule) is exactly what used to be forgotten.
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
  today,
  asOf,
  timezone,
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
  /** When the page was read: what «in force» and «still to come» are judged against. */
  asOf: string;
  /** The studio's zone: a rule starts at its midnight, and is dated by it. */
  timezone: string;
  /** The studio's date, `YYYY-MM-DD`: the first day a rule can change from. */
  today: string;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const valueField = useRef<HTMLInputElement>(null);
  const localeCode = localeTag(locale);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeCode);

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<"owner" | "specialist">("owner");
  const [basis, setBasis] = useState<"fixed_monthly" | "percent_revenue">("fixed_monthly");
  const [specialistId, setSpecialistId] = useState(specialists[0]?.id ?? "");
  const [reserve, setReserve] = useState(String(reserveMinor / 100));
  const isSolo = businessType === "solo";

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
      ...(recipient === "specialist" ? { specialist_id: specialistId } : {}),
      label: String(data.get("label") ?? "").trim() || undefined,
      basis,
      ...(basis === "fixed_monthly"
        ? { amount_minor: Math.round(value * 100) }
        : { basis_points: Math.round(value * 100) }),
      payroll_tax_basis_points: Math.round(tax * 100),
      ...effectiveDateFrom(data, today),
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

  /*
   * In force or still to come, against history. A rule changed from a later
   * day is closed at that day, not now: until then it is the one being paid,
   * and it belongs in the table beside the rule that will replace it.
   */
  const now = Date.parse(asOf);
  const live = rules.filter((rule) => rule.active_to === null || Date.parse(rule.active_to) > now);
  const closed = rules.filter((rule) => rule.active_to !== null && Date.parse(rule.active_to) <= now);
  const dateOf = (iso: string) => new Date(iso).toLocaleDateString(localeCode, { timeZone: timezone });

  /** «Изменить с даты» on a row: the form below, already pointed at that arrangement. */
  function changeFrom(rule: LaborCostRow) {
    setRecipient(rule.recipient);
    if (rule.specialist_id) setSpecialistId(rule.specialist_id);
    setBasis(rule.basis);
    setError(null);
    valueField.current?.focus();
  }

  /*
   * «Кому» over a column with one possible answer.
   *
   * For a studio the column carries the name of a salaried master, and without
   * it two salaries are two indistinguishable rows. For a woman working alone
   * every row says «Оплата вашего труда» and carries the same «Владелец»
   * badge, and what tells her rules apart is the arrangement and the date the
   * two remaining columns already give her.
   *
   * Read from the rows rather than from the type alone, because the two can
   * disagree: the type only ever moves solo → studio by itself
   * (`lib/solo-mode.ts`), so a workspace put back to solo through
   * `PATCH /organizations/settings` may still hold a master's salary. The
   * column comes back the moment there is a name in it worth reading, and an
   * empty table is the same one answer as a table of her own.
   */
  const ownerOnlyRules = isSolo && live.every((rule) => rule.recipient === "owner");

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
            <Hint
              short={t("labor.hintShort")}
              more={t(businessLabel.laborHint[businessType])}
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
                  {!ownerOnlyRules && <th>{t("labor.who")}</th>}
                  <th>{t("labor.arrangement")}</th>
                  <th className="labor-since">{t("labor.since")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {live.length === 0 && (
                  <tr>
                    <td colSpan={ownerOnlyRules ? 3 : 4} className="muted">
                      {t("labor.none")}
                    </td>
                  </tr>
                )}
                {live.map((rule) => (
                  <tr key={rule.id}>
                    {!ownerOnlyRules && (
                      <td>
                        {nameOf(rule)}
                        {rule.recipient === "owner" && <span className="badge-accent">{t("specialists.principal")}</span>}
                      </td>
                    )}
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
                      {nameOf(rule)}: {describe(rule)} — {dateOf(rule.active_from)} … {dateOf(rule.active_to!)}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {canEdit && (
              <form className="inline-form" onSubmit={addRule}>
                {/*
                  Somebody working alone is not asked whose wage this is.
                  There is one arrangement available to her — her own hour —
                  and «Кому» offering a choice between herself and «Оклад
                  мастера» is a question with one real answer and one that
                  leads to an empty picker. `recipient` stays "owner", which is
                  what it already defaults to, so the form posts the same body
                  it would have posted after she chose.
                */}
                {isSolo ? null : (
                  <>
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
                        <select
                          name="specialist_id"
                          required
                          value={specialistId}
                          onChange={(event) => setSpecialistId(event.target.value)}
                        >
                          {specialists.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
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
                    ref={valueField}
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

                <EffectiveDateField today={today} locale={locale} />

                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.save")}
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
