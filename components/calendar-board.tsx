"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { clockAt, groupBookings, type CalendarView } from "@/components/calendar-grouping";
import {
  addLocalDays,
  formatLocalDate,
  localToUtc,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
} from "@/domain/timezone";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { formatMoneyMinor } from "@/lib/format";

export type { CalendarView };

/**
 * The staff calendar's interactive half, roadmap section 7.2.
 *
 * Times are shown exactly as the server rendered them — in the location's own
 * zone — and are converted back the same way when something is written, using
 * the same `domain/timezone` functions the availability engine uses. Letting
 * the browser interpret a wall-clock time would put a Chișinău appointment into
 * whichever zone the receptionist's laptop happens to be set to.
 */

export type CalendarBooking = Readonly<{
  id: string;
  localDate: string;
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  timezone: string;
  status: string;
  version: number;
  specialistId: string;
  specialistName: string;
  locationId: string;
  locationName: string;
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  serviceName: string;
  extraLines: number;
  priceMinor: number;
  confirmationDueAt: string | null;
}>;

type Option = Readonly<{ id: string; name: string }>;

/** Statuses that still occupy the specialist, and so still have actions. */
const LIVE_STATUSES = new Set(["pending_confirmation", "confirmed"]);

const CANCELLATION_REASONS = ["client_request", "studio_request", "no_contact", "duplicate", "other"];

type Alternative = Readonly<{ date: string; slots: string[] }>;

export function CalendarBoard({
  view,
  days,
  today,
  bookings,
  locations,
  specialists,
  services,
  addOns,
  assignments,
  clients,
  filters,
  ownSpecialistId,
  canWrite,
  canFilterBySpecialist,
  currency,
  localeTag,
  locale,
}: {
  view: CalendarView;
  days: string[];
  today: string;
  bookings: CalendarBooking[];
  locations: readonly Readonly<{ id: string; name: string; timezone: string }>[];
  specialists: readonly Option[];
  services: readonly Readonly<{ id: string; name: string; durationMinutes: number | null }>[];
  addOns: readonly Option[];
  assignments: readonly Readonly<{ specialistId: string; locationId: string }>[];
  clients: readonly Option[];
  filters: Readonly<{ location: string; specialist: string; status: string }>;
  ownSpecialistId: string | null;
  canWrite: boolean;
  canFilterBySpecialist: boolean;
  currency: string;
  localeTag: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The alternatives arrive as UTC instants and have to be read back in the
  // zone of the location they belong to, so the zone travels with them.
  const [alternatives, setAlternatives] = useState<{ zone: string; entries: Alternative[] }>({
    zone: "UTC",
    entries: [],
  });
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag);

  /**
   * One key per distinct request, reused while the request stays the same.
   * That is what makes a double click one appointment: the second submission
   * carries the key the first one claimed, and the server answers with the
   * booking it already made instead of making another.
   */
  const idempotency = useRef<{ payload: string; key: string } | null>(null);
  function keyFor(payload: string) {
    if (idempotency.current?.payload !== payload) {
      idempotency.current = { payload, key: crypto.randomUUID() };
    }
    return idempotency.current.key;
  }

  async function send(
    url: string,
    body: unknown,
    options: { method?: string; key?: string; zone?: string } = {},
  ) {
    setPending(true);
    setError(null);
    setAlternatives({ zone: options.zone ?? "UTC", entries: [] });

    const response = await fetch(url, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      body: JSON.stringify(body),
    });

    setPending(false);

    if (response.ok) {
      idempotency.current = null;
      router.refresh();
      return true;
    }

    const failure = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string; details?: { alternatives?: Alternative[] } };
    } | null;

    const code = failure?.error?.code;
    // Section 7.8: losing the slot must not leave the form empty-handed. The
    // refusal already carries the next free times; showing them is the whole
    // point of putting them there.
    if (code === "SLOT_UNAVAILABLE") {
      setAlternatives({
        zone: options.zone ?? "UTC",
        entries: failure?.error?.details?.alternatives ?? [],
      });
    }
    setError(
      code
        ? getErrorMessage(code, failure?.error?.message ?? t("common.saveFailed"), locale)
        : t("common.saveFailed"),
    );
    return false;
  }

  /** A wall-clock time at a location, turned into the instant it names. */
  function instantAt(timezone: string, date: string, time: string): Date | "invalid" | "gap" {
    const localDate = parseLocalDate(date);
    const minutes = parseLocalTime(time);
    if (!localDate || minutes === null) return "invalid";

    // A DST gap is a time that does not exist. Silently rounding it forward
    // would book an appointment at an hour the studio never chose.
    const resolution = resolveLocal(localDate, minutes, timezone);
    if (resolution.kind === "gap") return "gap";
    return localToUtc(localDate, minutes, timezone);
  }

  function timezoneOf(locationId: string) {
    return locations.find((place) => place.id === locationId)?.timezone ?? "UTC";
  }

  async function createBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const locationId = String(data.get("location_id"));

    const when = instantAt(timezoneOf(locationId), String(data.get("date")), String(data.get("time")));
    if (when === "invalid") return setError(t("calendar.timeInvalid"));
    if (when === "gap") return setError(t("calendar.timeDoesNotExist"));

    let clientId = String(data.get("client_id") ?? "");
    const newClient = String(data.get("client_name") ?? "").trim();

    // A walk-in has no record yet, and making one should not be a separate trip
    // to another screen while the client is standing at the desk.
    if (!clientId && newClient) {
      const created = await fetch("/api/v1/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newClient,
          ...(String(data.get("client_phone") ?? "").trim()
            ? { phone: String(data.get("client_phone")).trim() }
            : {}),
        }),
      });
      if (!created.ok) {
        const body = (await created.json().catch(() => null)) as { error?: { message: string } } | null;
        return setError(body?.error?.message ?? t("common.saveFailed"));
      }
      clientId = ((await created.json()) as { data: { id: string } }).data.id;
    }

    const payload = {
      location_id: locationId,
      specialist_id: String(data.get("specialist_id")),
      service_id: String(data.get("service_id")),
      add_on_ids: data.getAll("add_on_ids").map(String),
      ...(clientId ? { client_id: clientId } : {}),
      starts_at: when.toISOString(),
    };

    const created = await send("/api/v1/bookings", payload, {
      key: keyFor(JSON.stringify(payload)),
      zone: timezoneOf(locationId),
    });
    if (created) form.reset();
  }

  async function blockTime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const locationId = String(data.get("location_id") ?? "");
    const timezone = locationId ? timezoneOf(locationId) : (locations[0]?.timezone ?? "UTC");

    const date = String(data.get("date"));
    const from = instantAt(timezone, date, String(data.get("from")));
    const to = instantAt(timezone, date, String(data.get("to")));
    if (from === "invalid" || to === "invalid") return setError(t("calendar.timeInvalid"));
    if (from === "gap" || to === "gap") return setError(t("calendar.timeDoesNotExist"));
    if (to <= from) return setError(t("calendar.blockOrder"));

    if (
      await send("/api/v1/availability/exceptions", {
        specialist_id: String(data.get("specialist_id")),
        ...(locationId ? { location_id: locationId } : {}),
        kind: "unavailable",
        starts_at: from.toISOString(),
        ends_at: to.toISOString(),
      })
    ) {
      form.reset();
    }
  }

  async function reschedule(booking: CalendarBooking, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const when = instantAt(booking.timezone, String(data.get("date")), String(data.get("time")));
    if (when === "invalid") return setError(t("calendar.timeInvalid"));
    if (when === "gap") return setError(t("calendar.timeDoesNotExist"));

    await send(
      `/api/v1/bookings/${booking.id}/reschedule`,
      {
        starts_at: when.toISOString(),
        specialist_id: String(data.get("specialist_id")),
        version: booking.version,
      },
      { zone: booking.timezone },
    );
  }

  async function cancel(booking: CalendarBooking, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await send(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: String(data.get("reason")),
      cancelled_by: String(data.get("cancelled_by")),
      version: booking.version,
    });
  }

  const grouped = groupBookings(view, days, bookings, specialists);

  /**
   * Only the people who actually work at the chosen address are offered.
   * The endpoint refuses the rest with `SPECIALIST_NOT_AT_LOCATION`, and a
   * dropdown listing choices that cannot work is worse than a shorter one.
   * An empty assignment table means a studio that has not filled it in, so
   * everyone is offered rather than nobody.
   */
  const [composeLocation, setComposeLocation] = useState(locations[0]?.id ?? "");
  const bookable = specialists.filter((person) => {
    if (ownSpecialistId !== null && person.id !== ownSpecialistId) return false;
    const theirs = assignments.filter((link) => link.specialistId === person.id);
    return theirs.length === 0 || theirs.some((link) => link.locationId === composeLocation);
  });

  return (
    <>
      <nav className="calendar-toolbar" aria-label={t("calendar.period")}>
        <div className="calendar-views" role="group" aria-label={t("calendar.view")}>
          {(["day", "week", "list"] as const).map((option) => (
            <Link
              key={option}
              href={queryFor({ ...filters, view: option, date: days[0] })}
              className={option === view ? "active" : undefined}
              aria-current={option === view ? "true" : undefined}
            >
              {t(`calendar.view.${option}` as MessageKey)}
            </Link>
          ))}
        </div>

        <div className="calendar-steps">
          <Link
            className="secondary-button"
            href={queryFor({ ...filters, view, date: shiftDate(days[0], -days.length) })}
            aria-label={t("calendar.previous")}
          >
            ←
          </Link>
          <Link className="secondary-button" href={queryFor({ ...filters, view, date: today })}>
            {t("calendar.today")}
          </Link>
          <Link
            className="secondary-button"
            href={queryFor({ ...filters, view, date: shiftDate(days[0], days.length) })}
            aria-label={t("calendar.next")}
          >
            →
          </Link>
        </div>
      </nav>

      <form className="inline-form" method="get">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="date" value={days[0]} />
        <label>
          {t("calendar.location")}
          <select name="location" defaultValue={filters.location}>
            <option value="">{t("calendar.allLocations")}</option>
            {locations.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </label>
        {canFilterBySpecialist && (
          <label>
            {t("calendar.specialist")}
            <select name="specialist" defaultValue={filters.specialist}>
              <option value="">{t("calendar.allSpecialists")}</option>
              {specialists.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t("calendar.status")}
          <select name="status" defaultValue={filters.status}>
            <option value="">{t("calendar.allStatuses")}</option>
            <option value="pending_confirmation,confirmed">{t("calendar.statusLive")}</option>
            <option value="pending_confirmation">{t("bookingStatus.pending_confirmation")}</option>
            <option value="confirmed">{t("bookingStatus.confirmed")}</option>
            <option value="cancelled">{t("bookingStatus.cancelled")}</option>
            <option value="completed">{t("bookingStatus.completed")}</option>
            <option value="no_show">{t("bookingStatus.no_show")}</option>
          </select>
        </label>
        <button className="secondary-button" type="submit">
          {t("calendar.apply")}
        </button>
      </form>

      {error && (
        <div className="form-error" role="alert">
          {error}
          {alternatives.entries.length > 0 && (
            <ul className="compact-list">
              {alternatives.entries.map((option) => (
                <li key={option.date}>
                  {option.date}:{" "}
                  {option.slots.map((slot) => clockAt(slot, alternatives.zone)).join(", ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {grouped.map((group) => (
        <section className="panel calendar-group" key={group.key}>
          <h2>{group.title}</h2>
          {group.bookings.length === 0 ? (
            <p className="muted">{t("calendar.emptyDay")}</p>
          ) : (
            <ul className="calendar-list">
              {group.bookings.map((booking) => (
                <li key={booking.id} className={`calendar-entry status-${booking.status}`}>
                  <details>
                    <summary>
                      <span className="calendar-time">
                        {booking.localStart}–{booking.localEnd}
                      </span>
                      <span className="calendar-what">
                        {booking.serviceName}
                        {booking.extraLines > 0 && <span className="unit-hint">+{booking.extraLines}</span>}
                      </span>
                      <span className="calendar-who">
                        {booking.clientName ?? t("calendar.noClient")}
                        {view !== "day" && <span className="unit-hint">{booking.specialistName}</span>}
                      </span>
                      {/* Never colour alone (section 7.8): the status is words. */}
                      <span className="calendar-status">
                        {t(`bookingStatus.${booking.status}` as MessageKey)}
                      </span>
                    </summary>

                    <div className="calendar-detail">
                      <p className="muted">
                        {booking.locationName} · {booking.specialistName} · {money(booking.priceMinor)}
                        {booking.clientPhone && ` · ${booking.clientPhone}`}
                      </p>
                      <p className="muted">
                        {t("calendar.inZone", { zone: booking.timezone })}
                        {booking.confirmationDueAt &&
                          ` · ${t("calendar.answerBy", {
                            when: new Date(booking.confirmationDueAt).toLocaleString(localeTag, {
                              timeZone: booking.timezone,
                            }),
                          })}`}
                      </p>

                      <p>
                        <Link className="text-link" href={`/app/calendar/${booking.id}`}>
                          {t("calendar.openCard")}
                        </Link>
                      </p>

                      {canWrite && LIVE_STATUSES.has(booking.status) && (
                        <div className="calendar-actions">
                          {booking.status === "pending_confirmation" && (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={pending}
                              onClick={() =>
                                send(`/api/v1/bookings/${booking.id}/confirm`, { version: booking.version })
                              }
                            >
                              {t("calendar.confirm")}
                            </button>
                          )}
                          {booking.status === "confirmed" && (
                            <>
                              <button
                                type="button"
                                className="primary-button"
                                disabled={pending}
                                onClick={() =>
                                  send(`/api/v1/bookings/${booking.id}/complete`, {
                                    version: booking.version,
                                  })
                                }
                              >
                                {t("calendar.complete")}
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={pending}
                                onClick={() =>
                                  send(`/api/v1/bookings/${booking.id}/no-show`, {
                                    version: booking.version,
                                  })
                                }
                              >
                                {t("calendar.noShow")}
                              </button>
                            </>
                          )}

                          <details className="calendar-subform">
                            <summary>{t("calendar.move")}</summary>
                            <form className="inline-form" onSubmit={(event) => reschedule(booking, event)}>
                              <label>
                                {t("calendar.date")}
                                <input type="date" name="date" defaultValue={booking.localDate} required />
                              </label>
                              <label>
                                {t("calendar.time")}
                                <input type="time" name="time" defaultValue={booking.localStart} required />
                              </label>
                              <label>
                                {t("calendar.specialist")}
                                <select name="specialist_id" defaultValue={booking.specialistId}>
                                  {specialists
                                    .filter(
                                      (person) =>
                                        ownSpecialistId === null || person.id === ownSpecialistId,
                                    )
                                    .map((person) => (
                                      <option key={person.id} value={person.id}>
                                        {person.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <button className="primary-button" type="submit" disabled={pending}>
                                {pending ? t("common.saving") : t("calendar.move")}
                              </button>
                            </form>
                          </details>

                          <details className="calendar-subform">
                            <summary>{t("calendar.cancel")}</summary>
                            <form className="inline-form" onSubmit={(event) => cancel(booking, event)}>
                              <label>
                                {t("calendar.reason")}
                                <select name="reason" defaultValue="client_request">
                                  {CANCELLATION_REASONS.map((reason) => (
                                    <option key={reason} value={reason}>
                                      {t(`cancelReason.${reason}` as MessageKey)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                {t("calendar.cancelledBy")}
                                <select name="cancelled_by" defaultValue="client">
                                  <option value="client">{t("calendar.byClient")}</option>
                                  <option value="staff">{t("calendar.byStudio")}</option>
                                </select>
                              </label>
                              <button className="danger-button" type="submit" disabled={pending}>
                                {t("calendar.cancel")}
                              </button>
                            </form>
                          </details>
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {canWrite && locations.length > 0 && services.length > 0 && (
        <section className="panel">
          <h2>{t("calendar.newBooking")}</h2>
          <p className="muted">{t("calendar.newBookingHint")}</p>
          <form className="inline-form" onSubmit={createBooking}>
            <label>
              {t("calendar.location")}
              <select
                name="location_id"
                required
                value={composeLocation}
                onChange={(event) => setComposeLocation(event.target.value)}
              >
                {locations.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("calendar.specialist")}
              <select name="specialist_id" required>
                {bookable.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("calendar.service")}
              <select name="service_id" required>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("calendar.date")}
              <input type="date" name="date" defaultValue={days[0]} required />
            </label>
            <label>
              {t("calendar.time")}
              <input type="time" name="time" required />
            </label>
            <label>
              {t("calendar.client")}
              <select name="client_id" defaultValue="">
                <option value="">{t("calendar.newClient")}</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("calendar.clientName")}
              <input name="client_name" maxLength={200} placeholder={t("calendar.clientNameHint")} />
            </label>
            <label>
              {t("calendar.clientPhone")}
              <input name="client_phone" inputMode="tel" maxLength={32} />
            </label>
            {addOns.length > 0 && (
              <fieldset className="checkbox-set">
                <legend>{t("calendar.addOns")}</legend>
                {addOns.map((addOn) => (
                  <label key={addOn.id} className="consent-field">
                    <input type="checkbox" name="add_on_ids" value={addOn.id} />
                    <span>{addOn.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? t("common.saving") : t("calendar.book")}
            </button>
          </form>
        </section>
      )}

      {canWrite && specialists.length > 0 && (
        <section className="panel">
          <h2>{t("calendar.blockTime")}</h2>
          <p className="muted">{t("calendar.blockHint")}</p>
          <form className="inline-form" onSubmit={blockTime}>
            <label>
              {t("calendar.specialist")}
              <select name="specialist_id" required defaultValue={ownSpecialistId ?? undefined}>
                {specialists
                  .filter((person) => ownSpecialistId === null || person.id === ownSpecialistId)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("calendar.location")}
              <select name="location_id" defaultValue="">
                <option value="">{t("calendar.everyLocation")}</option>
                {locations.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("calendar.date")}
              <input type="date" name="date" defaultValue={days[0]} required />
            </label>
            <label>
              {t("calendar.from")}
              <input type="time" name="from" required />
            </label>
            <label>
              {t("calendar.to")}
              <input type="time" name="to" required />
            </label>
            <button className="secondary-button" type="submit" disabled={pending}>
              {t("calendar.block")}
            </button>
          </form>
        </section>
      )}
    </>
  );
}

function queryFor(state: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(state)) if (value) params.set(name, value);
  return `/app/calendar?${params.toString()}`;
}

function shiftDate(date: string, days: number) {
  const parsed = parseLocalDate(date);
  return parsed ? formatLocalDate(addLocalDays(parsed, days)) : date;
}

