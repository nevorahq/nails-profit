"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";
import { NameCombobox } from "@/components/name-combobox";
import {
  SetupGuideDialog,
  useSetupGuide,
  type SetupGuideBaseline,
} from "@/components/setup-guide";

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
  hasOwnCard = false,
  setupGuide = null,
}: {
  specialists: SpecialistRow[];
  services: ServiceOption[];
  members: OrganizationMember[];
  currency: string;
  locale: AppLocale;
  canManage: boolean;
  /**
   * Whether the person on this screen is already catalogued as a master.
   *
   * When they are not — the usual state of a solo studio on its first day —
   * «Это я» is offered pre-ticked, because in a studio of one the first master
   * added is the owner more often than not.
   */
  hasOwnCard?: boolean;
  /**
   * Where «Первый расчёт» stood when this page was drawn, or null once the
   * studio has closed a visit and the guided run is over.
   */
  setupGuide?: SetupGuideBaseline;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const guide = useSetupGuide(setupGuide);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Which master is one click from being removed. Null while nobody is. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [exceptionOpen, setExceptionOpen] = useState(false);
  /*
   * Whose rule the panel is open for, and for which service.
   *
   * A master with no rule at all had nowhere to go from their own row: the cell
   * said «не задана» in a badge that did nothing, while the thing that would
   * fix it was a panel below, asking again which master was meant. Both are now
   * the same form, opened already pointing at the row somebody pressed.
   */
  const [ruleSpecialist, setRuleSpecialist] = useState("");
  const [ruleService, setRuleService] = useState("");
  /*
   * The panel is at the bottom of a long table, so opening it from a cell near
   * the top used to look like nothing happening at all: the state flipped, the
   * form appeared, and it was two screens below the button that summoned it.
   */
  const ruleRef = useRef<HTMLDivElement>(null);
  const [serviceEditor, setServiceEditor] = useState<ServiceEditor | null>(null);
  /*
   * The rule builder needs two pieces of state, and they are per form: showing
   * the guaranteed-amount field only for a hybrid, and remembering which
   * services a rule pays on. An empty list means every service.
   */
  const [addName, setAddName] = useState("");
  const [addRuleType, setAddRuleType] = useState("percentage");
  /*
   * Read only to explain the field below it. A master on a salary or renting a
   * chair still needs a rule — the engine asks for one whoever they are — and
   * for them the honest answer is 0, which is a different thing from an empty
   * box. Saying so beside the field beats a validation message after the fact.
   */
  const [addCooperation, setAddCooperation] = useState("commission");
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
    /*
     * Asked after every write here, not only after adding a master: the step is
     * «мастер с действующим правилом», and a rule written for an existing
     * master finishes it just as a new card does. `check` opens the window only
     * when the count actually moved, so the rest cost one request and nothing
     * on screen.
     */
    await guide.check();
    return true;
  }

  /**
   * The three shapes the API and the database both insist on: an amount, a
   * rate, or — for a hybrid — one of each.
   */
  function ruleFromForm(data: FormData) {
    const type = String(data.get("rule_type"));
    /*
     * An empty field is not a zero.
     *
     * `Number("")` is 0 and passes `Number.isFinite`, so leaving the box blank
     * used to write a real 0% rule: the master appeared to work for nothing,
     * every margin on the dashboard read too high, and nothing on screen said
     * so — a rule was there, so no banner and no refusal. A blank field means
     * the question was not answered, and the form says so instead.
     */
    const typed = String(data.get("rule_value") ?? "").trim();
    const value = Number(typed);
    if (typed === "" || !Number.isFinite(value)) return null;

    const base = String(data.get("rule_base") ?? "after_discount");
    if (type === "fixed") return { type, fixed_amount_minor: Math.round(value * 100) };

    const typedGuarantee = String(data.get("rule_guaranteed") ?? "").trim();
    const guaranteed = Number(typedGuarantee);
    if (type === "hybrid") {
      if (typedGuarantee === "" || !Number.isFinite(guaranteed)) return null;
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
    /*
     * No rule, no specialist. The API takes the rule as optional so a row can
     * be created first, but a master reaches this studio through one door and
     * behind it the rule is not optional at all: `recordCompletedVisit` refuses
     * with MISSING_COMMISSION_RULE, and the refusal arrives at the end of a
     * visit rather than here.
     */
    if (!rule) {
      setError(t("specialists.valueRequired"));
      return;
    }
    const ok = await send(
      "/api/v1/specialists",
      {
        name: data.get("name"),
        cooperation_type: data.get("cooperation_type"),
        // Two facts in one tick: this card is the account signed in now, and
        // the commission booked to it is the owner's own — see the endpoint.
        ...(data.get("is_me") ? { is_me: true } : {}),
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
      setAddCooperation("commission");
    }
  }

  /**
   * A card for somebody who is already in the studio.
   *
   * The sequence it repairs: invite a master, they accept, and they appear in
   * «Команда» and nowhere else — no row in «Мастера» to book them into, and
   * «Связать мастера с аккаунтом» offering an empty list, because the thing it
   * links to did not exist yet. One press writes the card and the link
   * together; the commission rule stays the owner's decision, and the banner
   * above already names everyone missing one.
   */
  async function cardForMember(member: OrganizationMember) {
    await send("/api/v1/specialists", {
      name: member.name?.trim() || member.email.split("@")[0],
      cooperation_type: "commission",
      user_id: member.user_id,
    });
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
    const service = String(data.get("service_id") ?? "");
    const ok = await send(
      `/api/v1/specialists/${data.get("specialist_id")}/commission-rules`,
      // Empty means «все услуги», which is what a default rule is: the endpoint
      // reads an absent service_id as exactly that.
      { ...rule, ...(service ? { service_id: service } : {}) },
      form,
    );
    if (ok) setExceptionOpen(false);
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

  /*
   * Anybody without a rule, whatever they are paid by.
   *
   * This used to ask for `cooperation_type === "commission"` as well, on the
   * reading that a master on a salary or renting a chair has no commission to
   * describe. The costing engine does not read it that way: it asks for a rule
   * for whoever worked the visit, and refuses the close without one. So a
   * `staff` or `rent` master imported from a file with no percentage column sat
   * here unremarked and could not be closed on — the one state this banner
   * exists to name. A rent or salary arrangement is written as a 0% rule, which
   * is a statement that nothing is taken per visit rather than an unanswered
   * question.
   */
  const withoutRule = specialists.filter((person) => person.default_rule === null);

  // One account belongs to one specialist, so an account already linked is not
  // offered again — the database refuses it anyway, and a dropdown that lists
  // choices which cannot work is worse than a shorter one.
  const linked = new Set(specialists.map((person) => person.user_id).filter(Boolean));
  const unlinkedMembers = members.filter((member) => !linked.has(member.user_id));

  /*
   * Members who can do the work and have nowhere to do it from. A manager or an
   * analyst is not one of them — they are not booked and have no calendar — so
   * only masters are named, and only while nothing is linked to their account.
   */
  const waitingForCard = unlinkedMembers.filter((member) => member.role === "master");

  /*
   * A studio has one owner who works, or none.
   *
   * The mark decides how the month's report reads: a principal's commission is
   * added back below the margin because it never left the business (see
   * `domain/period-pl.ts`). Two of them would add back two people's pay and
   * report a profit the studio does not have — so while one is marked, the
   * button is gone from everybody else's row rather than offered and refused.
   * Removing the mark brings it back for all of them.
   */
  const principal = specialists.find((person) => person.is_principal) ?? null;

  return (
    <>
      <SetupGuideDialog guide={guide} locale={locale} />

      {canManage && waitingForCard.length > 0 && (
        <section className="panel">
          <h2>{t("specialists.waitingTitle")}</h2>
          <p className="muted">{t("specialists.waitingHint")}</p>
          <ul className="compact-list">
            {waitingForCard.map((member) => (
              <li key={member.user_id} className="waiting-member">
                <span>
                  {member.name?.trim() || member.email.split("@")[0]}
                  <span className="unit-hint">{member.email}</span>
                </span>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={pending}
                  onClick={() => cardForMember(member)}
                >
                  {t("specialists.waitingAction")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
                {!hasOwnCard && (
                  <label className="checkbox-row">
                    <input type="checkbox" name="is_me" defaultChecked />
                    {t("specialists.isMe")}
                    <span className="field-hint">{t("specialists.isMeHint")}</span>
                  </label>
                )}
                <label>
                  {t("specialists.cooperation")}
                  <select
                    name="cooperation_type"
                    value={addCooperation}
                    onChange={(event) => setAddCooperation(event.target.value)}
                  >
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
                    <input name="rule_guaranteed" type="number" step="0.01" min="0" placeholder="100" required />
                  </label>
                )}
                <label>
                  {t("specialists.value")}
                  <input name="rule_value" type="number" step="0.01" min="0" placeholder="40" required />
                  {addCooperation !== "commission" && (
                    <span className="muted">{t("specialists.zeroRuleHint")}</span>
                  )}
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
                {canManage && (principal === null || principal.id === person.id) && (
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
                ) : canManage ? (
                  // The badge used to state the gap and do nothing about it.
                  <button
                    className="badge-warning badge-button"
                    type="button"
                    onClick={() => {
                      setRuleSpecialist(person.id);
                      setRuleService("");
                      setExceptionOpen(true);
                      // After the panel has been told to open, not before.
                      requestAnimationFrame(() =>
                        ruleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
                      );
                    }}
                  >
                    {t("specialists.notSet")}
                  </button>
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

      {/*
        Services are not a precondition. They are needed to write an exception
        *for* a service, and not at all for the rule that pays on everything —
        which is the one a studio is missing when the table says «не задана».
        Requiring them hid the only control that could fix it from exactly the
        studio that had not got that far yet.
      */}
      {canManage && specialists.length > 0 && (
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
          <div
            className={`add-form-wrap${exceptionOpen ? "" : " add-form-closed"}`}
            ref={ruleRef}
          >
            <div className="add-form-inner">
              <section className="panel">
                <h2>{t("specialists.serviceException")}</h2>
                <p className="muted">
{t("specialists.exceptionHint")}
                </p>
                <form className="inline-form" onSubmit={addException}>
                  <label>
                    {t("specialists.specialist")}
                    <select
                      name="specialist_id"
                      value={ruleSpecialist || specialists[0]?.id || ""}
                      onChange={(event) => setRuleSpecialist(event.target.value)}
                    >
                      {specialists.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("services.service")}
                    <select
                      name="service_id"
                      value={ruleService}
                      onChange={(event) => setRuleService(event.target.value)}
                    >
                      {/* The default rule, which is «все услуги» rather than a
                          service left unchosen. */}
                      <option value="">{t("specialists.defaultRuleOption")}</option>
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
