"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { NameCombobox } from "@/components/name-combobox";
import { SpecialistPhoto } from "@/components/specialist-photo";
import { describeRule, ruleFromForm } from "@/lib/commission-rule";
import type { SpecialistRow } from "@/lib/specialist-cards";
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

type ServiceOption = { id: string; name: string; duration_minutes: number | null };


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
              <form className="inline-form specialist-add-form" onSubmit={createSpecialist}>
                {/*
                  «Это я» qualifies the name above it rather than standing
                  beside it, so the two are one column and one item in the row.
                */}
                <div className="specialist-name-field">
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
                    <label>
                      <input type="checkbox" name="is_me" defaultChecked />
                      {t("specialists.isMe")}
                    </label>
                  )}
                </div>
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
            <th>{t("specialists.account")}</th>
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
              <td>
                {/*
                  The name is the way in. Everything decided about one master —
                  their rule, the exceptions to it, the services they are booked
                  for, the account behind them, their photograph — is on their
                  own page now; this table answers who works here, how they are
                  paid, and whether they can sign in.
                */}
                <SpecialistPhoto
                  specialistId={person.id}
                  name={person.name}
                  version={person.avatar_version}
                  canManage={false}
                  href={`/app/specialists/${person.id}`}
                  locale={locale}
                />
              </td>
              {/*
                The principal mark reads beside the cooperation type because it
                answers the same question — how this person is paid.
                `badge-accent`, not `badge-warning`: it states a fact, it is not
                something to go and fix.
              */}
              <td>
                {t(`cooperation.${person.cooperation_type}` as MessageKey)}
                {person.is_principal && <span className="badge-accent">{t("specialists.principal")}</span>}
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
                {person.user_id ? (
                  members.find((member) => member.user_id === person.user_id)?.email ?? person.user_id
                ) : (
                  <span className="badge-warning">{t("specialists.notLinked")}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

    </>
  );
}
