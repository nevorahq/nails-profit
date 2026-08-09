"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { clockAt, groupBookings, type CalendarView } from "@/components/calendar-grouping";
import { ToolIcon } from "@/components/icons";
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

export type CalendarException = Readonly<{
  id: string;
  localDate: string;
  localStart: string;
  localEnd: string;
  timezone: string;
  specialistId: string;
  specialistName: string;
  locationId: string | null;
  locationName: string | null;
  reason: string | null;
}>;

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

type RecipeMaterial = {
  material_id: string;
  material_name: string;
  base_unit: string;
  normative_quantity_milli_units: number;
};

type BookingRecipe = { durationMinutes: number; materials: RecipeMaterial[] };

/* --- The day view's time grid --- */

/** "09:30" as minutes past midnight. The strings are already local wall clock. */
function minutesOf(clock: string) {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/** The hours the grid draws, widened to whole hours around what the day holds. */
const DEFAULT_GRID = { from: 8 * 60, to: 20 * 60 };

function gridBounds(spans: readonly { start: number; end: number }[]) {
  const from = Math.min(DEFAULT_GRID.from, ...spans.map((s) => s.start));
  const to = Math.max(DEFAULT_GRID.to, ...spans.map((s) => s.end));
  return { from: Math.floor(from / 60) * 60, to: Math.ceil(to / 60) * 60 };
}

/**
 * Side-by-side columns for entries that overlap in time.
 *
 * A specialist cannot be double-booked — the availability engine refuses it —
 * but blocked time is stored separately from bookings and may cover a slot that
 * already has one, and a cancelled appointment still shows next to whatever
 * replaced it. Without this the later card would simply cover the earlier one
 * and the day would look emptier than it is.
 *
 * Greedy: each entry takes the first lane whose previous occupant has finished.
 */
function assignLanes<T extends { start: number; end: number }>(spans: T[]) {
  const laneEnds: number[] = [];
  const placed = spans.map((span) => {
    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane === -1) lane = laneEnds.push(span.start) - 1;
    laneEnds[lane] = span.end;
    return { ...span, lane };
  });
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

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
  exceptions,
  canWrite,
  showFilters,
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
  exceptions: readonly CalendarException[];
  canWrite: boolean;
  showFilters: boolean;
  canFilterBySpecialist: boolean;
  currency: string;
  localeTag: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<Record<string, BookingRecipe | "loading" | "error">>({});
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

  async function loadRecipe(bookingId: string) {
    if (recipes[bookingId]) return;
    setRecipes((prev) => ({ ...prev, [bookingId]: "loading" }));
    const response = await fetch(`/api/v1/bookings/${bookingId}/recipe`);
    if (response.ok) {
      const body = (await response.json()) as { data: BookingRecipe };
      setRecipes((prev) => ({ ...prev, [bookingId]: body.data }));
    } else {
      setRecipes((prev) => ({ ...prev, [bookingId]: "error" }));
    }
  }

  async function complete(booking: CalendarBooking, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const recipe = recipes[booking.id];
    const materials = typeof recipe === "object" && recipe !== null ? recipe.materials : [];

    const durationRaw = String(data.get("actual_duration") ?? "").trim();
    const consumption = materials.map((m) => ({
      material_id: m.material_id,
      actual_quantity: Number(String(data.get(`actual-${m.material_id}`) ?? "").trim()),
    }));

    await send(`/api/v1/bookings/${booking.id}/complete`, {
      version: booking.version,
      ...(durationRaw ? { actual_duration_minutes: Number(durationRaw) } : {}),
      consumption,
    });
  }

  const grouped = groupBookings(view, days, bookings, specialists);

  // For the day view, specialists who have a blocked slot but no bookings that
  // day won't appear in `grouped` (which only shows people with appointments).
  // Add a group for each such specialist so their block is visible.
  const allGroups = [...grouped];
  if (view === "day") {
    const covered = new Set(grouped.map((g) => g.key));
    const seen = new Set<string>();
    for (const exc of exceptions) {
      if (exc.localDate === days[0] && !covered.has(exc.specialistId) && !seen.has(exc.specialistId)) {
        seen.add(exc.specialistId);
        allGroups.push({ key: exc.specialistId, title: exc.specialistName, bookings: [] });
      }
    }
  }

  /**
   * Only the people who actually work at the chosen address are offered.
   * The endpoint refuses the rest with `SPECIALIST_NOT_AT_LOCATION`, and a
   * dropdown listing choices that cannot work is worse than a shorter one.
   * An empty assignment table means a studio that has not filled it in, so
   * everyone is offered rather than nobody.
   */
  const [composeLocation, setComposeLocation] = useState(locations[0]?.id ?? "");

  /*
   * The compose form's `<details>` opens on its own summary click — that part
   * is the browser's. This only handles the anchors that point at it from
   * elsewhere: the toolbar's «Новая запись» button and the round one in the
   * mobile title row (`app/app/calendar/page.tsx`, a Server Component, so it
   * cannot hold this listener itself).
   *
   * Delegated on `document` rather than attached to one link, because the two
   * anchors are rendered by two different components and neither is in scope
   * of the other. `block: "nearest"` is what makes the phone/desktop split in
   * the request happen without branching on viewport width: the form usually
   * sits below the fold on a phone and already inside it on a wide screen, so
   * "scroll only if it is not already visible" produces exactly that split.
   *
   * The round mobile button is the one place this doubles as a close control
   * (its "+" is a "−" once the panel is open, purely via the `:has()` rule on
   * `.header-action .icon-minus` in globals.css) — the toolbar's labelled
   * button stays open-only, since it is never on screen at the same time as
   * the panel it would be closing. The `toggle` event, which fires on the
   * `<details>` whichever way it changed (this handler, or its own summary),
   * is what keeps that button's `aria-label` in sync in every case.
   */
  const composeRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function revealCompose() {
      const details = composeRef.current;
      if (!details) return;
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest('a[href="#new-booking"]');
      if (!trigger) return;
      event.preventDefault();
      const details = composeRef.current;
      if (!details) return;
      if (trigger.classList.contains("header-action")) {
        details.open = !details.open;
        if (details.open) details.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else {
        revealCompose();
      }
    }

    function onToggle() {
      const details = composeRef.current;
      if (!details) return;
      document.querySelectorAll<HTMLAnchorElement>('a.header-action[href="#new-booking"]').forEach((button) => {
        const label = details.open ? button.dataset.labelOpen : button.dataset.labelClosed;
        if (label) button.setAttribute("aria-label", label);
      });
    }

    const details = composeRef.current;
    document.addEventListener("click", onClick);
    details?.addEventListener("toggle", onToggle);
    // A direct link or a page refresh with the hash already set: the browser
    // scrolled to the closed `<details>` before this ran, so it is opened and
    // recentred rather than left shut with the summary sitting at the top.
    if (location.hash === "#new-booking") revealCompose();
    return () => {
      document.removeEventListener("click", onClick);
      details?.removeEventListener("toggle", onToggle);
    };
  }, []);

  const bookable = specialists.filter((person) => {
    if (ownSpecialistId !== null && person.id !== ownSpecialistId) return false;
    const theirs = assignments.filter((link) => link.specialistId === person.id);
    return theirs.length === 0 || theirs.some((link) => link.locationId === composeLocation);
  });

  /*
   * The day view is a timetable rather than a list: one column per specialist,
   * hours down the side, and each appointment drawn where it actually sits.
   * Week and list stay lists — a week of columns does not fit a phone, and the
   * list is what gets searched rather than read as a clock.
   */
  const dayItems =
    view === "day"
      ? [
          ...bookings.filter((b) => b.localDate === days[0]),
          ...exceptions.filter((e) => e.localDate === days[0]),
        ]
      : [];
  /*
   * An empty day keeps the old panel. With nothing to place, `groupBookings`
   * falls back to a single group titled with the date, and drawing that as a
   * timetable puts a specialist column headed "2026-08-09" above twelve empty
   * hours — a grid that says less than the sentence it replaced.
   */
  const isGrid = view === "day" && dayItems.length > 0;
  const daySpans = dayItems.map((item) => ({
    start: minutesOf(item.localStart),
    end: minutesOf(item.localEnd),
  }));
  const bounds = gridBounds(daySpans);
  const gridHours = Array.from(
    { length: (bounds.to - bounds.from) / 60 + 1 },
    (_, index) => bounds.from / 60 + index,
  );

  /** Where an entry sits in the grid, in whole rows of one hour each. */
  const rows = (minutes: number) => (minutes - bounds.from) / 60;

  /*
   * The «now» line, and why it is state rather than computed during render.
   *
   * The server renders this page, so a time computed inline would be the
   * server's clock baked into HTML that the browser then hydrates against its
   * own — a mismatch React would warn about, and a line that stops moving. It
   * is filled in after mount instead, and ticks each minute.
   */
  const zone =
    locations.find((place) => place.id === filters.location)?.timezone ??
    locations[0]?.timezone ??
    "UTC";
  const [nowMinutes, setNowMinutes] = useState<number | null>(null);

  useEffect(() => {
    if (!isGrid || days[0] !== today) return;
    const read = () =>
      setNowMinutes(
        minutesOf(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: zone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date()),
        ),
      );
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [isGrid, days, today, zone]);

  const nowInView =
    nowMinutes !== null && nowMinutes >= bounds.from && nowMinutes <= bounds.to ? nowMinutes : null;

  return (
    <>
      <nav className="calendar-toolbar" aria-label={t("calendar.period")}>
        <div className="calendar-steps">
          <Link className="secondary-button" href={queryFor({ ...filters, view, date: today })}>
            {t("calendar.today")}
          </Link>
          {/* One control in one frame, the way the direction draws it: the two
              arrows step the same period and belong together. */}
          <span className="calendar-stepper">
            <Link
              className="calendar-step"
              href={queryFor({ ...filters, view, date: shiftDate(days[0], -days.length) })}
              aria-label={t("calendar.previous")}
            >
              ←
            </Link>
            <Link
              className="calendar-step"
              href={queryFor({ ...filters, view, date: shiftDate(days[0], days.length) })}
              aria-label={t("calendar.next")}
            >
              →
            </Link>
          </span>
          {/*
            Midday rather than midnight: "2026-05-14" parses as UTC, and a
            browser west of Greenwich would render the day before.
          */}
          {/*
            Keyed to the view, not to `isGrid`: a day with nothing in it is
            still one day, and `isGrid` also turns off when there is nothing to
            place — which printed the range "2026-08-09 — 2026-08-09".
          */}
          <strong className="calendar-period">
            {view === "day" ? (
              /*
                Two spellings of one date, because the longest Russian spelling
                — «воскресенье, 20 сентября», 124 units — does not fit beside
                the buttons at 288, where about 109 are left for it. Only one is
                displayed at a time, so it is read out once.
              */
              <>
                <span className="period-long">
                  {new Date(`${days[0]}T12:00:00`).toLocaleDateString(localeTag, {
                    day: "numeric",
                    month: "long",
                    weekday: "long",
                  })}
                </span>
                <span className="period-short">
                  {new Date(`${days[0]}T12:00:00`).toLocaleDateString(localeTag, {
                    day: "numeric",
                    month: "short",
                    weekday: "short",
                  })}
                </span>
              </>
            ) : (
              `${days[0]} — ${days.at(-1)}`
            )}
          </strong>
        </div>

        <div className="calendar-tools">
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

          {showFilters && (
            /*
             * The three selects were open on the page at all times, which on a
             * phone pushed the day itself below the fold. `details` folds them
             * behind the button the direction shows without any state to keep:
             * the disclosure, the keyboard behaviour and the escape are the
             * browser's, and the form inside is byte-for-byte the one that was
             * already here.
             */
            <details className="calendar-filters">
              <summary>
                <ToolIcon name="filter" />
                {t("filters.title")}
              </summary>
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
            </details>
          )}

          {/*
            An anchor to the form that already exists further down the page,
            not a new one. The direction puts a primary action in the toolbar;
            duplicating the compose form to get it there would mean two places
            a booking can be made and two places a bug can live.
          */}
          {canWrite && locations.length > 0 && services.length > 0 && (
            <a className="primary-button calendar-create" href="#new-booking">
              <ToolIcon name="plus" />
              {t("calendar.newBooking")}
            </a>
          )}
        </div>
      </nav>

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

      <div
        className={isGrid ? "calendar-grid" : undefined}
        style={isGrid ? ({ "--calendar-span": gridHours.length - 1 } as React.CSSProperties) : undefined}
      >
        {isGrid && (
          /* The hour rail. Decorative: every card states its own time in text. */
          <div className="calendar-hours" aria-hidden="true">
            {gridHours.slice(0, -1).map((hour) => (
              <span key={hour}>{`${String(hour).padStart(2, "0")}:00`}</span>
            ))}
          </div>
        )}

        <div className={isGrid ? "calendar-columns" : undefined}>
      {allGroups.map((group) => {
        const groupExceptions =
          view === "day"
            ? exceptions.filter((e) => e.specialistId === group.key && e.localDate === days[0])
            : view === "week"
              ? exceptions.filter((e) => e.localDate === group.key)
              : exceptions;

        type GroupItem =
          | { kind: "booking"; data: CalendarBooking }
          | { kind: "exception"; data: CalendarException };

        const items: GroupItem[] = [
          ...group.bookings.map((b) => ({ kind: "booking" as const, data: b })),
          ...groupExceptions.map((e) => ({ kind: "exception" as const, data: e })),
        ].sort((a, b) => a.data.localStart.localeCompare(b.data.localStart));

        // `items` is already in start order, so the lanes come back in the same
        // order and can be read by the index of the entry being drawn.
        const laid = isGrid
          ? assignLanes(
              items.map((item) => ({
                start: minutesOf(item.data.localStart),
                end: minutesOf(item.data.localEnd),
              })),
            )
          : null;

        const slotOf = (index: number): React.CSSProperties | undefined => {
          if (!laid) return undefined;
          const span = laid.placed[index];
          return {
            top: `calc(var(--calendar-row) * ${rows(span.start)})`,
            height: `calc(var(--calendar-row) * ${(span.end - span.start) / 60})`,
            insetInlineStart: `${(span.lane / laid.lanes) * 100}%`,
            width: `${(1 / laid.lanes) * 100}%`,
          };
        };

        return (
        <section
          className={isGrid ? "calendar-column" : "panel calendar-group"}
          key={group.key}
        >
          <h2>{group.title}</h2>
          {items.length === 0 && !isGrid ? (
            <p className="muted">{t("calendar.emptyDay")}</p>
          ) : (
            <ul className="calendar-list">
              {items.map((item, index) => {
                if (item.kind === "exception") {
                  const exc = item.data;
                  return (
                    <li key={exc.id} className="calendar-entry status-blocked" style={slotOf(index)}>
                      <details>
                        <summary>
                          <span className="calendar-time">
                            {exc.localStart}–{exc.localEnd}
                          </span>
                          <span className="calendar-what">
                            {t("calendar.blockedLabel")}
                            {exc.reason && <span className="unit-hint">{exc.reason}</span>}
                          </span>
                          {view !== "day" && (
                            <span className="calendar-who">{exc.specialistName}</span>
                          )}
                        </summary>
                        <div className="calendar-detail">
                          <p className="muted">
                            {exc.locationName ?? t("calendar.allLocations")}
                            {" · "}
                            {exc.specialistName}
                          </p>
                          <p className="muted">{t("calendar.inZone", { zone: exc.timezone })}</p>
                          {canWrite && (
                            <button
                              className="danger-button"
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                send(
                                  `/api/v1/availability/exceptions?id=${exc.id}`,
                                  undefined,
                                  { method: "DELETE" },
                                )
                              }
                            >
                              {pending ? t("common.saving") : t("calendar.unblock")}
                            </button>
                          )}
                        </div>
                      </details>
                    </li>
                  );
                }
                const booking = item.data;
                return (
                <li
                  key={booking.id}
                  className={`calendar-entry status-${booking.status}`}
                  style={slotOf(index)}
                >
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
                              <details
                                className="calendar-subform"
                                onToggle={(e) => {
                                  if ((e.currentTarget as HTMLDetailsElement).open) {
                                    loadRecipe(booking.id);
                                  }
                                }}
                              >
                                <summary>{t("calendar.complete")}</summary>
                                <form className="inline-form" onSubmit={(e) => complete(booking, e)}>
                                  {(() => {
                                    const r = recipes[booking.id];
                                    const dur = typeof r === "object" && r !== null ? r.durationMinutes : undefined;
                                    return (
                                      <label>
                                        {t("closeVisit.actualMinutes")}
                                        <input
                                          key={dur ?? "pending"}
                                          name="actual_duration"
                                          type="number"
                                          min="1"
                                          step="1"
                                          defaultValue={dur}
                                        />
                                      </label>
                                    );
                                  })()}
                                  {recipes[booking.id] === "loading" && (
                                    <p className="muted">{t("calendar.loadingRecipe")}</p>
                                  )}
                                  {recipes[booking.id] === "error" && (
                                    <p className="muted">{t("closeVisit.noRecipe")}</p>
                                  )}
                                  {typeof recipes[booking.id] === "object" && recipes[booking.id] !== null && (
                                    (() => {
                                      const recipe = recipes[booking.id] as BookingRecipe;
                                      return recipe.materials.length > 0 ? (
                                        <table className="data-table">
                                          <thead>
                                            <tr>
                                              <th>{t("common.material")}</th>
                                              <th>{t("closeVisit.norm")}</th>
                                              <th>{t("closeVisit.actual")}</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {recipe.materials.map((m) => (
                                              <tr key={m.material_id}>
                                                <td>{m.material_name}</td>
                                                <td className="muted">
                                                  {m.normative_quantity_milli_units / 1000} {m.base_unit}
                                                </td>
                                                <td>
                                                  <input
                                                    aria-label={`${t("closeVisit.actual")} — ${m.material_name}`}
                                                    name={`actual-${m.material_id}`}
                                                    type="number"
                                                    step="0.001"
                                                    min="0"
                                                    defaultValue={m.normative_quantity_milli_units / 1000}
                                                  />
                                                  <span className="unit-hint">{m.base_unit}</span>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      ) : (
                                        <p className="muted">{t("closeVisit.noRecipe")}</p>
                                      );
                                    })()
                                  )}
                                  <button className="primary-button" type="submit" disabled={pending}>
                                    {pending ? t("common.saving") : t("calendar.complete")}
                                  </button>
                                </form>
                              </details>
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
                );
              })}
            </ul>
          )}
        </section>
        );
      })}
        </div>

        {isGrid && nowInView !== null && (
          <div className="calendar-now" style={{ top: `calc(var(--calendar-row) * ${rows(nowInView)})` }}>
            <span>{`${String(Math.floor(nowInView / 60)).padStart(2, "0")}:${String(nowInView % 60).padStart(2, "0")}`}</span>
          </div>
        )}
      </div>

      {canWrite && locations.length > 0 && services.length > 0 && (
        /*
         * Closed by default. The form was open on the page at all times, which
         * on a phone put an eleven-field form between the day and the next
         * thing worth scrolling to. `<details>` gives the open/close and the
         * keyboard behaviour for free; the toolbar and header actions layer a
         * scroll-into-view on top rather than duplicating either.
         */
        <details className="panel calendar-compose" id="new-booking" ref={composeRef}>
          <summary>
            <h2>{t("calendar.newBooking")}</h2>
          </summary>
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
        </details>
      )}

      {canWrite && specialists.length > 0 && (
        <details className="panel calendar-compose calendar-block-time">
          <summary>
            <h2>{t("calendar.blockTime")}</h2>
          </summary>
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
        </details>
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

