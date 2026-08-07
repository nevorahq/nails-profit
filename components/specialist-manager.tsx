"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

export type OrganizationMember = {
  user_id: string;
  email: string;
  role: string;
};

export type SpecialistRow = {
  id: string;
  name: string;
  cooperation_type: string;
  user_id: string | null;
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
  members,
  currency,
  locale,
  canManage,
}: {
  specialists: SpecialistRow[];
  services: { id: string; name: string }[];
  members: OrganizationMember[];
  currency: string;
  locale: AppLocale;
  canManage: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);

  async function send(url: string, payload: unknown, form?: HTMLFormElement, method = "POST") {
    setPending(true);
    setError(null);
    const hasBody = method !== "DELETE" && payload !== null;
    const response = await fetch(url, {
      method,
      headers: hasBody ? { "content-type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined,
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

  async function linkAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await send(
      `/api/v1/specialists/${data.get("specialist_id")}`,
      { user_id: data.get("user_id") },
      form,
      "PATCH",
    );
  }

  async function unlinkAccount(specialistId: string) {
    await send(`/api/v1/specialists/${specialistId}`, { user_id: null }, undefined, "PATCH");
  }

  async function deleteSpecialist(specialistId: string) {
    await send(`/api/v1/specialists/${specialistId}`, null, undefined, "DELETE");
  }

  const withoutRule = specialists.filter(
    (person) => person.cooperation_type === "commission" && person.default_rule === null,
  );

  // One account belongs to one specialist, so an account already linked is not
  // offered again — the database refuses it anyway, and a dropdown that lists
  // choices which cannot work is worse than a shorter one.
  const linked = new Set(specialists.map((person) => person.user_id).filter(Boolean));
  const unlinkedMembers = members.filter((member) => !linked.has(member.user_id));

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
        <>
          <div className="add-form-toggle">
            {addOpen ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn-toggle-close" type="button" onClick={() => setAddOpen(false)} aria-label={t("common.cancel")}>−</button>
              </div>
            ) : (
              <button className="primary-button" type="button" style={{ width: "100%" }} onClick={() => setAddOpen(true)}>
                {t("specialists.add")}
              </button>
            )}
          </div>
          <div className={`add-form-wrap${addOpen ? "" : " add-form-closed"}`}>
            <div className="add-form-inner">
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
            </div>
          </div>
        </>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("specialists.specialist")}</th>
            <th>{t("specialists.cooperation")}</th>
            <th>{t("specialists.defaultRule")}</th>
            <th>{t("specialists.exceptions")}</th>
            <th>{t("specialists.account")}</th>
          </tr>
        </thead>
        <tbody>
          {specialists.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
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
              <td>
                {person.user_id ? (
                  <>
                    {members.find((member) => member.user_id === person.user_id)?.email ?? person.user_id}
                    {canManage && (
                      <button
                        className="inline-action"
                        type="button"
                        disabled={pending}
                        onClick={() => unlinkAccount(person.id)}
                      >
                        {t("specialists.unlink")}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="inline-actions">
                    <span className="badge-warning">{t("specialists.notLinked")}</span>
                    {canManage && (
                      <button
                        className="inline-action danger"
                        type="button"
                        disabled={pending}
                        onClick={() => deleteSpecialist(person.id)}
                      >
                        {t("common.delete")}
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canManage && specialists.length > 0 && (
        <>
          <div className="add-form-toggle">
            {linkOpen ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn-toggle-close" type="button" onClick={() => setLinkOpen(false)} aria-label={t("common.cancel")}>−</button>
              </div>
            ) : (
              <button className="primary-button" type="button" style={{ width: "100%" }} onClick={() => setLinkOpen(true)}>
                {t("specialists.linkAccount")}
              </button>
            )}
          </div>
          <div className={`add-form-wrap${linkOpen ? "" : " add-form-closed"}`}>
            <div className="add-form-inner">
              <section className="panel">
                <h2>{t("specialists.linkAccount")}</h2>
                <p className="muted">{t("specialists.linkHint")}</p>
                {unlinkedMembers.length === 0 ? (
                  <p className="muted">{t("specialists.noMembers")}</p>
                ) : (
                  <form className="inline-form" onSubmit={linkAccount}>
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
                      {t("specialists.member")}
                      <select name="user_id">
                        {unlinkedMembers.map((member) => (
                          <option key={member.user_id} value={member.user_id}>
                            {member.email} — {t(`roles.${member.role}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="primary-button" type="submit" disabled={pending}>
                      {pending ? t("common.saving") : t("specialists.link")}
                    </button>
                  </form>
                )}
              </section>
            </div>
          </div>
        </>
      )}

      {canManage && specialists.length > 0 && services.length > 0 && (
        <>
          <div className="add-form-toggle">
            {exceptionOpen ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn-toggle-close" type="button" onClick={() => setExceptionOpen(false)} aria-label={t("common.cancel")}>−</button>
              </div>
            ) : (
              <button className="primary-button" type="button" style={{ width: "100%" }} onClick={() => setExceptionOpen(true)}>
                {t("specialists.serviceException")}
              </button>
            )}
          </div>
          <div className={`add-form-wrap${exceptionOpen ? "" : " add-form-closed"}`}>
            <div className="add-form-inner">
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
            </div>
          </div>
        </>
      )}
    </>
  );
}

