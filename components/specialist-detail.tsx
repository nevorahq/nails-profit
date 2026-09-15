"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SpecialistPhoto } from "@/components/specialist-photo";
import type { AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { WEEKDAY_KEYS } from "@/components/booking-setup";
import { bookabilityOf } from "@/domain/bookability";
import { DEFAULT_WORKWEEK } from "@/domain/workspace-defaults";
import type { Weekday } from "@/domain/timezone";
import { factsFor, type SpecialistPlace } from "@/lib/specialist-bookability";
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
  showsPay,
  places,
  publishedLocationIds,
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
  /**
   * Whether this reader is owed what this person is paid — false for an
   * analyst, whose card arrives already stripped by `loadSpecialistCards`.
   * Three blocks come off with it: the rate in the facts, the account behind
   * the card, and the whole commission panel, which is a form rather than a
   * reading and would be refused anyway.
   */
  showsPay: boolean;
  /** Where this master is assigned and on which days — see the panel below. */
  places: readonly SpecialistPlace[];
  /** Addresses a client can actually open, for the verdict on those places. */
  publishedLocationIds: readonly string[];
  canManage: boolean;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  /*
   * Addresses this card is at and has no week for. One is enough to offer the
   * studio's own: a master who works Tuesdays at one address and nothing at all
   * at the other is invisible to every client looking at the second.
   */
  const placesWithoutHours = places.filter((place) => place.weekdays.length === 0);
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
   * The studio's own week, for a card that has none.
   *
   * A card created now is given it outright (`POST /api/v1/specialists`), which
   * leaves exactly one case: everybody hired before that, whose card says
   * «часов нет» and whose only remedy was a rota editor on another screen, two
   * selects deep. Same week, same wording as «Онлайн-запись» — this is the
   * missing press, not a second rota editor.
   *
   * Only the addresses that have no hours, one request each: the endpoint takes
   * one pair at a time, and a rota somebody has actually written — at the other
   * address, or last winter — is not something a button offering a default may
   * overwrite. From today, so nothing that has already happened is re-answered.
   */
  async function setDefaultWeek() {
    for (const place of placesWithoutHours) {
      const written = await send(
        "/api/v1/availability/rules",
        {
          specialist_id: person.id,
          location_id: place.locationId,
          effective_from: new Date().toISOString().slice(0, 10),
          intervals: DEFAULT_WORKWEEK.weekdays.map((weekday) => ({
            weekday,
            start: DEFAULT_WORKWEEK.start,
            end: DEFAULT_WORKWEEK.end,
          })),
        },
        undefined,
        "PUT",
      );
      if (!written) return;
    }
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
  const verdict = bookabilityOf({
    publishedLocationIds,
    ...factsFor(places),
  });

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
          {showsPay && (
            <div>
              <dt>{t("specialists.defaultRule")}</dt>
              <dd>
                {rule ?? (
                  /*
                    The list makes this pill a link to this page; here it goes
                    to the form itself, which is far enough down that «не
                    задана» and the field that answers it were never on screen
                    together.
                  */
                  <a className="badge-warning badge-link" href="#commission">
                    {t("specialists.notSet")}
                  </a>
                )}
              </dd>
            </div>
          )}
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

      {showsPay && (
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
      )}

      {/*
        The question the studio actually asks the day after hiring somebody,
        and the one this page could not answer: can a client book them yet.

        Read here and changed on «Онлайн-запись» — the two rows that decide it
        are written there, two selects deep, and duplicating that editor would
        give a studio two places to set one thing. What was missing was the
        statement, not another form.
      */}
      <section className="panel">
        <h2>{t("specialists.whereTitle")}</h2>
        {verdict !== "bookable" && (
          <p className="warning-banner">
            {verdict === "no_address" ? t("specialists.whereEmpty") : t("specialists.whereNoHours")}
          </p>
        )}
        {places.length > 0 && (
          <ul className="compact-list">
            {places.map((place) => (
              <li key={place.locationId}>
                {place.name}
                {place.weekdays.length > 0 ? (
                  <span className="unit-hint">
                    {place.weekdays.map((day) => t(WEEKDAY_KEYS[day as Weekday])).join(" · ")}
                  </span>
                ) : (
                  <span className="badge-warning">{t("specialists.whereNoHours")}</span>
                )}
                {!place.published && (
                  <span className="unit-hint">{t("specialists.whereDraft")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && placesWithoutHours.length > 0 && (
          <>
            <p className="muted">
              {t("bookingSetup.setupWorkweek", {
                from: DEFAULT_WORKWEEK.start,
                to: DEFAULT_WORKWEEK.end,
              })}
            </p>
            <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={setDefaultWeek}
            >
              {pending ? t("common.saving") : t("bookingSetup.setupWorkweekAction")}
            </button>
          </>
        )}
        <p className="muted">{t("specialists.whereHint")}</p>
        <Link className="text-link" href="/app/booking">
          {t("specialists.openRota")}
        </Link>
      </section>

      {showsPay && (
      <section className="panel" id="commission">
        <h2>{t("specialists.commission")}</h2>
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
      )}

      <section className="panel">
        <h2>{t("specialists.offeredServices")}</h2>
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
