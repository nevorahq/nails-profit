"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

export type SpecialistRow = {
  id: string;
  name: string;
  cooperation_type: string;
  default_rule: {
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
  } | null;
  service_exceptions: {
    service_id: string | null;
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
  }[];
};

function describeRule(rule: SpecialistRow["default_rule"], currency: string, t: Translate) {
  if (!rule) return null;
  if (rule.type === "fixed") {
    return t("specialists.perService", {
      amount: formatMoneyMinor(rule.fixed_amount_minor ?? 0, currency),
    });
  }
  const rate = formatBasisPoints(rule.basis_points);
  return rule.type === "percentage_after_materials"
    ? t("specialists.afterMaterials", { rate })
    : t("specialists.ofRevenue", { rate });
}

export function SpecialistManager({
  specialists,
  services,
  currency,
  locale,
  canManage,
}: {
  specialists: SpecialistRow[];
  services: { id: string; name: string }[];
  currency: string;
  locale: AppLocale;
  canManage: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(url: string, payload: unknown, form?: HTMLFormElement) {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("common.saveFailed"));
      setPending(false);
      return;
    }
    form?.reset();
    setPending(false);
    router.refresh();
  }

  function ruleFromForm(data: FormData) {
    const type = String(data.get("rule_type"));
    const value = Number(String(data.get("rule_value") ?? "").trim());
    if (!Number.isFinite(value)) return null;
    return type === "fixed"
      ? { type, fixed_amount_minor: Math.round(value * 100) }
      : { type, basis_points: Math.round(value * 100) };
  }

  async function createSpecialist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rule = ruleFromForm(data);
    await send(
      "/api/v1/specialists",
      {
        name: data.get("name"),
        cooperation_type: data.get("cooperation_type"),
        ...(rule ? { default_rule: rule } : {}),
      },
      form,
    );
  }

  async function addException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rule = ruleFromForm(data);
    if (!rule) {
      setError(t("specialists.valueRequired"));
      return;
    }
    await send(
      `/api/v1/specialists/${data.get("specialist_id")}/commission-rules`,
      { ...rule, service_id: data.get("service_id") },
      form,
    );
  }

  const withoutRule = specialists.filter(
    (person) => person.cooperation_type === "commission" && person.default_rule === null,
  );

  return (
    <>
      {withoutRule.length > 0 && (
        <div className="warning-banner">
{t("specialists.withoutRuleBanner", { count: withoutRule.length })}
        </div>
      )}

      {!canManage && (
        <div className="warning-banner">
          {t("specialists.readOnlyNote")}
        </div>
      )}

      {canManage && (
        <section className="panel">
          <h2>{t("specialists.add")}</h2>
          <form className="inline-form" onSubmit={createSpecialist}>
            <label>
              {t("specialists.name")}
              <input name="name" required maxLength={200} placeholder={t("specialists.namePlaceholder")} />
            </label>
            <label>
              {t("specialists.cooperation")}
              <select name="cooperation_type" defaultValue="commission">
                <option value="commission">{t("cooperation.commission")}</option>
                <option value="rent">{t("cooperation.rent")}</option>
                <option value="staff">{t("cooperation.staff")}</option>
              </select>
            </label>
            <label>
              {t("specialists.commissionType")}
              <select name="rule_type" defaultValue="percentage">
                <option value="percentage">{t("commissionType.percentage")}</option>
                <option value="percentage_after_materials">{t("commissionType.percentage_after_materials")}</option>
                <option value="fixed">{t("commissionType.fixed")}</option>
              </select>
            </label>
            <label>
              {t("specialists.value")}
              <input name="rule_value" type="number" step="0.01" min="0" placeholder="40" />
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("common.add")}
            </button>
          </form>
          <p className="muted">
            {t("specialists.valueHint", { currency })}
          </p>
        </section>
      )}

      {error && <div className="form-error">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("specialists.specialist")}</th>
            <th>{t("specialists.cooperation")}</th>
            <th>{t("specialists.defaultRule")}</th>
            <th>{t("specialists.exceptions")}</th>
          </tr>
        </thead>
        <tbody>
          {specialists.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                {t("specialists.none")}
              </td>
            </tr>
          )}
          {specialists.map((person) => (
            <tr key={person.id}>
              <td>{person.name}</td>
              <td>{t(`cooperation.${person.cooperation_type}` as MessageKey)}</td>
              <td>
                {person.default_rule ? (
                  describeRule(person.default_rule, currency, t)
                ) : (
                  <span className="badge-warning">{t("specialists.notSet")}</span>
                )}
              </td>
              <td>
                {person.service_exceptions.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <ul className="compact-list">
                    {person.service_exceptions.map((rule) => (
                      <li key={`${person.id}-${rule.service_id}`}>
                        {services.find((service) => service.id === rule.service_id)?.name ?? t("services.service")}:{" "}
                        {describeRule(rule, currency, t)}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canManage && specialists.length > 0 && services.length > 0 && (
        <section className="panel">
          <h2>{t("specialists.serviceException")}</h2>
          <p className="muted">
{t("specialists.exceptionHint")}
          </p>
          <form className="inline-form" onSubmit={addException}>
            <label>
              {t("specialists.specialist")}
              <select name="specialist_id">
                {specialists.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("services.service")}
              <select name="service_id">
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("specialists.type")}
              <select name="rule_type" defaultValue="percentage">
                <option value="percentage">{t("commissionType.percentage")}</option>
                <option value="percentage_after_materials">{t("commissionType.percentage_after_materials")}</option>
                <option value="fixed">{t("commissionType.fixed")}</option>
              </select>
            </label>
            <label>
              {t("specialists.value")}
              <input name="rule_value" type="number" step="0.01" min="0" placeholder="50" required />
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              {t("specialists.saveException")}
            </button>
          </form>
        </section>
      )}
    </>
  );
}

