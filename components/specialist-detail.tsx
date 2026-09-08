"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SpecialistPhoto } from "@/components/specialist-photo";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { describeRule, ruleFromForm } from "@/lib/commission-rule";
import type { SpecialistRow } from "@/lib/specialist-cards";

export type ServiceOption = { id: string; name: string; duration_minutes: number | null };

export type LinkableMember = {
  user_id: string;
  email: string;
  role: string;
};

/**
 * One master, and everything that is decided about them.
 *
 * All of this used to be a row in the table on `/app/specialists` — six columns
 * carrying a photo, a commission rule, a list of exceptions, a list of
 * services, an account and a delete, each with its own control, multiplied by
 * every master in the studio. The panels those controls opened sat at the foot
 * of the page and began by asking again which master was meant, because from
 * down there it was no longer obvious.
 *
 * A page per person answers that question by being open. The list above it goes
 * back to being a list: who works here, how they are paid, and whether they can
 * sign in.
 */
export function SpecialistDetail({
  person,
  services,
  linkableMembers,
  currency,
  locale,
  businessType,
  canManage,
}: {
  person: SpecialistRow;
  services: ServiceOption[];
  /** Accounts with no card of their own; empty for a role that cannot link. */
  linkableMembers: LinkableMember[];
  currency: string;
  locale: AppLocale;
  /**
   * Studio or someone working alone. Wording only, and only under the rate
   * field — see the comment there for why that field needs it most.
   */
  businessType: BusinessType;
  canManage: boolean;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ruleType, setRuleType] = useState("percentage");
  const [ruleService, setRuleService] = useState("");
  const [selected, setSelected] = useState<string[]>(
    person.service_assignments.map((assignment) => assignment.service_id),
  );
  const [durationByService, setDurationByService] = useState<Record<string, string>>(
    Object.fromEntries(
      person.service_assignments.map((assignment) => [
        assignment.service_id,
        assignment.duration_minutes === null ? "" : String(assignment.duration_minutes),
      ]),
    ),
  );
  const [workplaceByService, setWorkplaceByService] = useState<Record<string, boolean>>(
    Object.fromEntries(
      person.service_assignments.map((assignment) => [
        assignment.service_id,
        assignment.requires_workplace,
      ]),
    ),
  );

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

  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rule = ruleFromForm(data);
    if (!rule) {
      setError(t("specialists.valueRequired"));
      return;
    }
    const service = String(data.get("service_id") ?? "");
    // An absent service_id is «все услуги», which is what a default rule is.
    await send(
      `/api/v1/specialists/${person.id}/commission-rules`,
      { ...rule, ...(service ? { service_id: service } : {}) },
      form,
    );
  }

  async function saveServices(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await send(
      `/api/v1/specialists/${person.id}/services`,
      {
        services: selected.map((serviceId) => ({
          service_id: serviceId,
          duration_minutes: durationByService[serviceId]?.trim()
            ? Number(durationByService[serviceId])
            : null,
          requires_workplace: workplaceByService[serviceId] ?? false,
        })),
      },
      undefined,
      "PUT",
    );
  }

  async function linkAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await send(`/api/v1/specialists/${person.id}`, { user_id: data.get("user_id") }, form, "PATCH");
  }

  /**
   * Removing a master, in two clicks on purpose.
   *
   * The row goes for good when the master never worked — the one entered with a
   * typo, or the one who never started. A master who has visits or bookings is
   * archived instead: their commission is inside every financial snapshot those
   * visits wrote, and a payroll month with nobody attached to it is not a tidier
   * database, it is a broken report. Either way this page stops describing
   * anything, so it hands the reader back to the list rather than refreshing
   * into a card that is gone.
   */
  async function remove() {
    const removed = await send(`/api/v1/specialists/${person.id}`, null, undefined, "DELETE");
    if (removed) router.push("/app/specialists");
  }

  const rule = describeRule(person.default_rule, currency, t);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <Link className="text-link" href="/app/specialists">
            ← {t("specialists.title")}
          </Link>
          <h1>{person.name}</h1>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {!canManage && <div className="warning-banner">{t("specialists.readOnlyNote")}</div>}

      {/* No heading: the master's name is the one directly above, and a panel
          titled «Карточка» under it says only that a card is a card. */}
      <section className="panel">
        <SpecialistPhoto
          specialistId={person.id}
          name={person.name}
          version={person.avatar_version}
          canManage={canManage}
          withName={false}
          locale={locale}
        />
        <dl className="specialist-facts">
          <div>
            <dt>{t("specialists.cooperation")}</dt>
            <dd>
              {t(`cooperation.${person.cooperation_type}` as MessageKey)}
              {person.is_principal && <span className="badge-accent">{t("specialists.principal")}</span>}
            </dd>
          </div>
          <div>
            <dt>{t("specialists.defaultRule")}</dt>
            <dd>{rule ?? <span className="badge-warning">{t("specialists.notSet")}</span>}</dd>
          </div>
        </dl>
        {/*
          The principal mark sits beside the cooperation type because it answers
          the same question — how this person is paid. A studio has one working
          owner or none, so the button is offered only while this card is the
          one marked or nobody is; the endpoint refuses a second either way.
        */}
        {canManage && (
          <button
            className="inline-action"
            type="button"
            disabled={pending}
            onClick={() => send(`/api/v1/specialists/${person.id}`, { is_principal: !person.is_principal }, undefined, "PATCH")}
          >
            {person.is_principal ? t("specialists.principalUnset") : t("specialists.principalSet")}
          </button>
        )}
      </section>

      <section className="panel">
        <h2>{t("specialists.account")}</h2>
        {person.user_id ? (
          <div className="inline-actions">
            <span>{t("specialists.accountLinked")}</span>
            {canManage && (
              <button
                className="inline-action"
                type="button"
                disabled={pending}
                onClick={() => send(`/api/v1/specialists/${person.id}`, { user_id: null }, undefined, "PATCH")}
              >
                {t("specialists.unlink")}
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="muted">{t("specialists.linkHint")}</p>
            {!canManage ? (
              <span className="badge-warning">{t("specialists.notLinked")}</span>
            ) : linkableMembers.length === 0 ? (
              <p className="muted">{t("specialists.noMembers")}</p>
            ) : (
              <form className="inline-form" onSubmit={linkAccount}>
                <label>
                  {t("specialists.member")}
                  <select name="user_id">
                    {linkableMembers.map((member) => (
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
          </>
        )}
      </section>

      <section className="panel">
        <h2>{t("specialists.commission")}</h2>
        <p className="muted">{t("specialists.exceptionHint")}</p>
        {person.service_exceptions.length > 0 && (
          <ul className="compact-list">
            {person.service_exceptions.map((exception) => (
              <li key={exception.service_id}>
                {services.find((service) => service.id === exception.service_id)?.name ??
                  t("services.service")}
                : {describeRule(exception, currency, t)}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form className="inline-form" onSubmit={saveRule}>
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
                value={ruleType}
                onChange={(event) => setRuleType(event.target.value)}
              >
                <option value="percentage">{t("commissionType.percentage")}</option>
                <option value="fixed">{t("commissionType.fixed")}</option>
                <option value="hybrid">{t("commissionType.hybrid")}</option>
              </select>
            </label>
            {ruleType === "hybrid" && (
              <label>
                {t("specialists.guaranteed", { currency })}
                <input name="rule_guaranteed" type="number" step="0.01" min="0" placeholder="100" required />
              </label>
            )}
            <label>
              {t("specialists.value")}
              <input name="rule_value" type="number" step="0.01" min="0" placeholder="40" required />
              {person.cooperation_type !== "commission" && (
                <span className="muted">{t("specialists.zeroRuleHint")}</span>
              )}
              {/*
                The one field on this page a solo studio cannot answer from
                what the product has told it.
                
                This is where somebody working alone is sent by «Первый
                расчёт» — the card exists from the moment the workspace does,
                and the rate is all that is missing — so an empty box with a
                «40» in grey is the whole of the first task the product sets.
                What it is asking for is not a payment to anybody: it is the
                price of the hour, which is what makes two services
                comparable, and which the month's report then hands straight
                back (`domain/period-pl.ts`). Said here rather than only in
                that report, which is a fortnight away.
              */}
              {businessType === "solo" && person.is_principal && (
                <span className="muted">{t("specialists.imputedHint")}</span>
              )}
            </label>
            {ruleType !== "fixed" && (
              <label>
                {t("specialists.commissionBase")}
                <select name="rule_base" defaultValue="after_discount">
                  <option value="after_discount">{t("commissionBase.after_discount")}</option>
                  <option value="full_price">{t("commissionBase.full_price")}</option>
                </select>
              </label>
            )}
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("common.save")}
            </button>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>{t("specialists.offeredServices")}</h2>
        <p className="muted">{t("specialists.servicesHint")}</p>
        {!canManage || services.length === 0 ? (
          person.service_assignments.length === 0 ? (
            <p className="muted">{t("specialists.allServices")}</p>
          ) : (
            <ul className="compact-list">
              {person.service_assignments.map((assignment) => (
                <li key={assignment.service_id}>
                  {services.find((service) => service.id === assignment.service_id)?.name ??
                    t("services.service")}
                  {assignment.duration_minutes !== null && (
                    <span className="unit-hint">
                      {assignment.duration_minutes} {t("common.minutes")}
                    </span>
                  )}
                  {assignment.requires_workplace && (
                    <span className="unit-hint">{t("specialists.requiresWorkplace")}</span>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : (
          <form onSubmit={saveServices}>
            <fieldset className="specialist-service-list">
              {/* The panel's heading says this already; the legend is here so
                  the group has a name where the heading is not read as one. */}
              <legend className="sr-only">{t("specialists.offeredServices")}</legend>
              {services.map((service) => {
                const ticked = selected.includes(service.id);
                return (
                  <div className="specialist-service-row" key={service.id}>
                    <label className="checkbox-field specialist-service-name">
                      <input
                        type="checkbox"
                        checked={ticked}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, service.id]
                              : selected.filter((id) => id !== service.id),
                          )
                        }
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
                        disabled={!ticked}
                        placeholder={service.duration_minutes ? String(service.duration_minutes) : "—"}
                        value={durationByService[service.id] ?? ""}
                        onChange={(event) =>
                          setDurationByService({
                            ...durationByService,
                            [service.id]: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        disabled={!ticked}
                        checked={workplaceByService[service.id] ?? false}
                        onChange={(event) =>
                          setWorkplaceByService({
                            ...workplaceByService,
                            [service.id]: event.target.checked,
                          })
                        }
                      />
                      {t("specialists.requiresWorkplace")}
                    </label>
                  </div>
                );
              })}
            </fieldset>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("specialists.saveServices")}
            </button>
          </form>
        )}
      </section>

      {canManage && (
        <section className="panel">
          <h2>{t("specialists.removeTitle")}</h2>
          <p className="muted">{t("specialists.deleteHint")}</p>
          {confirmDelete ? (
            <div className="inline-actions">
              <button className="secondary-button danger" type="button" disabled={pending} onClick={remove}>
                {t("specialists.deleteConfirm")}
              </button>
              <button
                className="inline-action"
                type="button"
                disabled={pending}
                onClick={() => setConfirmDelete(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <button
              className="inline-action danger"
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                setConfirmDelete(true);
              }}
            >
              {t("common.delete")}
            </button>
          )}
        </section>
      )}
    </main>
  );
}
