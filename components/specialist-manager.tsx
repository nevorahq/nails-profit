"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import { NameCombobox } from "@/components/name-combobox";

export type OrganizationMember = {
  user_id: string;
  email: string;
  /** The account's own name, used when a card is created for them. */
  name?: string | null;
  role: string;
};

export type SpecialistRow = {
  id: string;
  name: string;
  cooperation_type: string;
  user_id: string | null;
  /** Takes the residual profit rather than a fee — the owner who also works. */
  is_principal: boolean;
  default_rule: {
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
    base: string;
  } | null;
  service_exceptions: {
    service_id: string | null;
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
    base: string;
  }[];
  service_assignments: {
    service_id: string;
    duration_minutes: number | null;
    requires_workplace: boolean;
  }[];
};

type ServiceOption = { id: string; name: string; duration_minutes: number | null };

type ServiceEditor = {
  specialistId: string;
  selected: string[];
  durationByService: Record<string, string>;
  workplaceByService: Record<string, boolean>;
};

function describeRule(rule: SpecialistRow["default_rule"], currency: string, t: Translate) {
  if (!rule) return null;
  if (rule.type === "fixed") {
    return t("specialists.perService", {
      amount: formatMoneyMinor(rule.fixed_amount_minor ?? 0, currency),
    });
  }
  const rate = formatBasisPoints(rule.basis_points);
  if (rule.type === "hybrid") {
    return t("specialists.hybridRule", {
      amount: formatMoneyMinor(rule.fixed_amount_minor ?? 0, currency),
      rate,
    });
  }
  const described = t("specialists.ofRevenue", { rate });
  // Only worth saying when it is not the usual answer. Every rule written
  // before the base existed is `after_discount`, and labelling all of them
  // would be noise on every row.
  return rule.base === "full_price" ? `${described} · ${t("commissionBase.full_price")}` : described;
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
  services: ServiceOption[];
  members: OrganizationMember[];
  currency: string;
  locale: AppLocale;
  canManage: boolean;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Which master is one click from being removed. Null while nobody is. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  const [serviceEditor, setServiceEditor] = useState<ServiceEditor | null>(null);
  /*
   * The rule builder needs two pieces of state, and they are per form: showing
   * the guaranteed-amount field only for a hybrid, and remembering which
   * services a rule pays on. An empty list means every service.
   */
  const [addName, setAddName] = useState("");
  const [addRuleType, setAddRuleType] = useState("percentage");
  const [exceptionRuleType, setExceptionRuleType] = useState("percentage");
  const [coveredServiceIds, setCoveredServiceIds] = useState<string[]>([]);

  /*
   * The add-specialist panel: nothing on the page until the header opens
   * it — the header anchors `app/app/specialists/page.tsx` renders are the
   * *only* control (`.header-action` on a phone, `.calendar-create` on a
   * desktop; a Server Component, so neither can hold this listener itself,
   * delegated on `document` for that reason). This used to be a `<details>`
   * whose own `<summary>` stayed visible — and clickable — while closed,
   * which put a second «Добавить мастера» directly under the header's own
   * button. A `.compose-wrap` collapsed by class has no such leftover strip.
   *
   * The other two panels below (link an account, service exception) keep
   * their older mobile-only toggle — only «Добавить мастера» was asked for.
   */
  // Lazy so it reads the real hash on the client's own first render rather
  // than in a follow-up effect — `location` does not exist during the
  // server's render of this "use client" component.
  const [addOpen, setAddOpen] = useState(() => typeof window !== "undefined" && location.hash === "#add-specialist");
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest('a[href="#add-specialist"]');
      if (!trigger) return;
      event.preventDefault();
      setAddOpen((open) => !open);
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (addOpen) addRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.querySelectorAll<HTMLAnchorElement>('a.header-action[href="#add-specialist"]').forEach((button) => {
      const label = addOpen ? button.dataset.labelOpen : button.dataset.labelClosed;
      if (label) button.setAttribute("aria-label", label);
    });
  }, [addOpen]);

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
      return false;
    }
    form?.reset();
    setPending(false);
    router.refresh();
    return true;
  }

  /**
   * The three shapes the API and the database both insist on: an amount, a
   * rate, or — for a hybrid — one of each.
   */
  function ruleFromForm(data: FormData) {
    const type = String(data.get("rule_type"));
    const value = Number(String(data.get("rule_value") ?? "").trim());
    if (!Number.isFinite(value)) return null;

    const base = String(data.get("rule_base") ?? "after_discount");
    if (type === "fixed") return { type, fixed_amount_minor: Math.round(value * 100) };

    const guaranteed = Number(String(data.get("rule_guaranteed") ?? "").trim());
    if (type === "hybrid") {
      if (!Number.isFinite(guaranteed)) return null;
      return {
        type,
        basis_points: Math.round(value * 100),
        fixed_amount_minor: Math.round(guaranteed * 100),
        base,
      };
    }
    return { type, basis_points: Math.round(value * 100), base };
  }

  async function createSpecialist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rule = ruleFromForm(data);
    const ok = await send(
      "/api/v1/specialists",
      {
        name: data.get("name"),
        cooperation_type: data.get("cooperation_type"),
        ...(rule
          ? {
              default_rule:
                coveredServiceIds.length > 0
                  ? { ...rule, covered_service_ids: coveredServiceIds }
                  : rule,
            }
          : {}),
      },
      form,
    );
    if (ok) {
      setAddOpen(false);
      setAddName("");
    }
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

  async function setPrincipal(specialistId: string, value: boolean) {
    await send(`/api/v1/specialists/${specialistId}`, { is_principal: value }, undefined, "PATCH");
  }

  /**
   * Removing a master, in two clicks on purpose.
   *
   * The row goes for good when the master never worked — the one entered with a
   * typo, or the one who never started. A master who has visits or bookings is
   * archived instead and the answer says so: their commission is inside every
   * financial snapshot those visits wrote, and a payroll month with nobody
   * attached to it is not a tidier database, it is a broken report.
   */
  async function deleteSpecialist(specialistId: string) {
    const removed = await send(`/api/v1/specialists/${specialistId}`, null, undefined, "DELETE");
    if (removed) setConfirmDelete(null);
  }

  function editServices(person: SpecialistRow) {
    setError(null);
    setServiceEditor({
      specialistId: person.id,
      selected: person.service_assignments.map((assignment) => assignment.service_id),
      durationByService: Object.fromEntries(
        person.service_assignments.map((assignment) => [
          assignment.service_id,
          assignment.duration_minutes === null ? "" : String(assignment.duration_minutes),
        ]),
      ),
      workplaceByService: Object.fromEntries(
        person.service_assignments.map((assignment) => [
          assignment.service_id,
          assignment.requires_workplace,
        ]),
      ),
    });
  }

  async function saveServices(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!serviceEditor) return;
    const entries = serviceEditor.selected.map((serviceId) => {
      const duration = serviceEditor.durationByService[serviceId]?.trim() ?? "";
      return {
        service_id: serviceId,
        duration_minutes: duration ? Number(duration) : null,
        requires_workplace: serviceEditor.workplaceByService[serviceId] ?? false,
      };
    });
    const ok = await send(
      `/api/v1/specialists/${serviceEditor.specialistId}/services`,
      { services: entries },
      undefined,
      "PUT",
    );
    if (ok) setServiceEditor(null);
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
        <div className={`compose-wrap${addOpen ? "" : " is-closed"}`} id="add-specialist" ref={addRef}>
          <div className="compose-inner">
            <section className="panel">
              <h2>{t("specialists.add")}</h2>
              <form className="inline-form" onSubmit={createSpecialist}>
                <NameCombobox
                  id="specialist-name"
                  name="name"
                  label={t("specialists.name")}
                  placeholder={t("specialists.namePlaceholder")}
                  title={t("specialists.memberSearchTitle")}
                  emptyLabel={t("specialists.noUnlinkedMembers")}
                  footnote={t("specialists.customNameHint")}
                  required
                  maxLength={200}
                  value={addName}
                  options={unlinkedMembers.map((member) => ({
                    key: member.user_id,
                    label: member.name?.trim() || member.email.split("@")[0],
                    hint: `${member.email} · ${t(`roles.${member.role}` as MessageKey)}`,
                  }))}
                  onChange={setAddName}
                  onSelect={(option) => setAddName(option.label)}
                />
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
                  <select
                    name="rule_type"
                    value={addRuleType}
                    onChange={(event) => setAddRuleType(event.target.value)}
                  >
                    <option value="percentage">{t("commissionType.percentage")}</option>
                    <option value="fixed">{t("commissionType.fixed")}</option>
                    <option value="hybrid">{t("commissionType.hybrid")}</option>
                  </select>
                </label>
                {addRuleType === "hybrid" && (
                  <label>
                    {t("specialists.guaranteed", { currency })}
                    <input name="rule_guaranteed" type="number" step="0.01" min="0" placeholder="100" />
                  </label>
                )}
                <label>
                  {t("specialists.value")}
                  <input name="rule_value" type="number" step="0.01" min="0" placeholder="40" />
                </label>
                {addRuleType !== "fixed" && (
                  <label>
                    {t("specialists.commissionBase")}
                    <select name="rule_base" defaultValue="after_discount">
                      <option value="after_discount">{t("commissionBase.after_discount")}</option>
                      <option value="full_price">{t("commissionBase.full_price")}</option>
                    </select>
                  </label>
                )}
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("common.add")}
                </button>
              </form>
              {/*
                Which services the rule pays on. Nothing ticked means all of
                them — the answer for almost every studio — so the list starts
                closed rather than as a wall of checkboxes nobody needs.
              */}
              {services.length > 0 && addRuleType !== "fixed" && (
                <details className="pl-history">
                  <summary>{t("specialists.coveredServices")}</summary>
                  <fieldset className="checkbox-set costing-view">
                    <legend>{t("specialists.coveredServicesLegend")}</legend>
                    {services.map((service) => (
                      <label key={service.id} className="radio-row">
                        <input
                          type="checkbox"
                          checked={coveredServiceIds.includes(service.id)}
                          onChange={(event) =>
                            setCoveredServiceIds(
                              event.target.checked
                                ? [...coveredServiceIds, service.id]
                                : coveredServiceIds.filter((value) => value !== service.id),
                            )
                          }
                        />{" "}
                        {service.name}
                      </label>
                    ))}
                  </fieldset>
                  <p className="muted">{t("specialists.coveredServicesHint")}</p>
                </details>
              )}
              <p className="muted">
                {t("specialists.valueHint", { currency })}
              </p>
            </section>
          </div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t("specialists.specialist")}</th>
            <th>{t("specialists.cooperation")}</th>
            <th>{t("specialists.defaultRule")}</th>
            <th>{t("specialists.exceptions")}</th>
            <th>{t("specialists.offeredServices")}</th>
            <th>{t("specialists.account")}</th>
          </tr>
        </thead>
        <tbody>
          {specialists.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t("specialists.none")}
              </td>
            </tr>
          )}
          {specialists.map((person) => (
            <tr key={person.id}>
              <td>{person.name}</td>
              {/*
                The principal mark lives beside the cooperation type because it
                answers the same question — how this person is paid — and not
                beside the account, where it would compete with two actions
                already there. `badge-accent`, not `badge-warning`: it states a
                fact, it is not something to go and fix.
              */}
              <td>
                {t(`cooperation.${person.cooperation_type}` as MessageKey)}
                {person.is_principal && <span className="badge-accent">{t("specialists.principal")}</span>}
                {canManage && (
                  <button
                    className="inline-action"
                    type="button"
                    disabled={pending}
                    onClick={() => setPrincipal(person.id, !person.is_principal)}
                  >
                    {person.is_principal ? t("specialists.principalUnset") : t("specialists.principalSet")}
                  </button>
                )}
              </td>
              <td>
                {person.default_rule ? (
                  <>
                    {describeRule(person.default_rule, currency, t)}
                    {/*
                      The rate means something different for a principal, and
                      the difference is the whole point of the mark: it is what
                      a hired master would have cost, not money that leaves.
                    */}
                    {person.is_principal && (
                      <span className="unit-hint">{t("specialists.imputedLabour")}</span>
                    )}
                  </>
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
                {person.service_assignments.length === 0 ? (
                  <span className="muted">{t("specialists.allServices")}</span>
                ) : (
                  <ul className="compact-list">
                    {person.service_assignments.map((assignment) => (
                      <li key={assignment.service_id}>
                        {services.find((service) => service.id === assignment.service_id)?.name ?? t("services.service")}
                        {assignment.duration_minutes !== null && (
                          <span className="unit-hint">{assignment.duration_minutes} {t("common.minutes")}</span>
                        )}
                        {assignment.requires_workplace && (
                          <span className="unit-hint">{t("specialists.requiresWorkplace")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && services.length > 0 && (
                  <button className="inline-action" type="button" disabled={pending} onClick={() => editServices(person)}>
                    {t("specialists.manageServices")}
                  </button>
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
                    {canManage &&
                      (confirmDelete === person.id ? (
                        <>
                          <button
                            className="inline-action danger"
                            type="button"
                            disabled={pending}
                            onClick={() => deleteSpecialist(person.id)}
                          >
                            {t("specialists.deleteConfirm")}
                          </button>
                          <button
                            className="inline-action"
                            type="button"
                            disabled={pending}
                            onClick={() => setConfirmDelete(null)}
                          >
                            {t("common.cancel")}
                          </button>
                          <span className="muted">{t("specialists.deleteHint")}</span>
                        </>
                      ) : (
                        <button
                          className="inline-action danger"
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            setError(null);
                            setConfirmDelete(person.id);
                          }}
                        >
                          {t("common.delete")}
                        </button>
                      ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        Explained once, under the table where the mark is set, rather than in a
        tooltip: it changes what the monthly report subtracts, and a control
        that moves money should say so in full sentences.
      */}
      {canManage && specialists.length > 0 && <p className="muted">{t("specialists.principalHint")}</p>}

      {canManage && serviceEditor && (
        <section className="panel specialist-services-panel">
          <h2>
            {t("specialists.servicesOf", {
              name: specialists.find((person) => person.id === serviceEditor.specialistId)?.name ?? "",
            })}
          </h2>
          <p className="muted">{t("specialists.servicesHint")}</p>
          <form onSubmit={saveServices}>
            <fieldset className="specialist-service-list">
              <legend>{t("specialists.offeredServices")}</legend>
              {services.map((service) => {
                const selected = serviceEditor.selected.includes(service.id);
                return (
                  <div className="specialist-service-row" key={service.id}>
                    <label className="checkbox-field specialist-service-name">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => setServiceEditor({
                          ...serviceEditor,
                          selected: event.target.checked
                            ? [...serviceEditor.selected, service.id]
                            : serviceEditor.selected.filter((id) => id !== service.id),
                        })}
                      />
                      <strong>{service.name}</strong>
                    </label>
                    <label>
                      {t("specialists.durationOverride")}
                      <input
                        type="number"
                        min="1"
                        max="720"
                        step="1"
                        disabled={!selected}
                        placeholder={service.duration_minutes ? String(service.duration_minutes) : "—"}
                        value={serviceEditor.durationByService[service.id] ?? ""}
                        onChange={(event) => setServiceEditor({
                          ...serviceEditor,
                          durationByService: {
                            ...serviceEditor.durationByService,
                            [service.id]: event.target.value,
                          },
                        })}
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        disabled={!selected}
                        checked={serviceEditor.workplaceByService[service.id] ?? false}
                        onChange={(event) => setServiceEditor({
                          ...serviceEditor,
                          workplaceByService: {
                            ...serviceEditor.workplaceByService,
                            [service.id]: event.target.checked,
                          },
                        })}
                      />
                      {t("specialists.requiresWorkplace")}
                    </label>
                  </div>
                );
              })}
            </fieldset>
            <div className="inline-actions">
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? t("common.saving") : t("specialists.saveServices")}
              </button>
              <button className="secondary-button" type="button" disabled={pending} onClick={() => setServiceEditor(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        </section>
      )}

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
                    <select
                      name="rule_type"
                      value={exceptionRuleType}
                      onChange={(event) => setExceptionRuleType(event.target.value)}
                    >
                      <option value="percentage">{t("commissionType.percentage")}</option>
                        <option value="fixed">{t("commissionType.fixed")}</option>
                      <option value="hybrid">{t("commissionType.hybrid")}</option>
                    </select>
                  </label>
                  {exceptionRuleType === "hybrid" && (
                    <label>
                      {t("specialists.guaranteed", { currency })}
                      <input name="rule_guaranteed" type="number" step="0.01" min="0" placeholder="100" required />
                    </label>
                  )}
                  <label>
                    {t("specialists.value")}
                    <input name="rule_value" type="number" step="0.01" min="0" placeholder="50" required />
                  </label>
                  {exceptionRuleType !== "fixed" && (
                    <label>
                      {t("specialists.commissionBase")}
                      <select name="rule_base" defaultValue="after_discount">
                        <option value="after_discount">{t("commissionBase.after_discount")}</option>
                        <option value="full_price">{t("commissionBase.full_price")}</option>
                      </select>
                    </label>
                  )}
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
