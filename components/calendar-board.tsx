"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  clockAt,
  freeWindows,
  rotaFor,
  toHalfHours,
  totalMinutes,
  type ShiftRule,
  type Span,
} from "@/components/calendar-free-time";
import { ClientContact } from "@/components/client-contact";
import { ToolIcon } from "@/components/icons";
import {
  formatLocalDate,
  localDateWeekday,
  localToUtc,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
} from "@/domain/timezone";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import { specialistOptions } from "@/lib/specialist-options";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { formatMoneyMinor } from "@/lib/format";

/**
 * One date in the month grid.
 *
 * `marks` is already capped and already in the order the day runs; `total` is
 * how many things actually stand in it. The two differ exactly when a cell has
 * more than it can draw, which is the case the count exists for.
 */
export type CalendarMonthDay = Readonly<{
  date: string;
  /** A date from a neighbouring month, drawn quieter but still clickable. */
  outside: boolean;
  marks: readonly string[];
  total: number;
}>;

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
  /** The card's own name, present only when the booking was made under another. */
  clientCardName: string | null;
  clientPhone: string | null;
  serviceName: string;
  extraLines: number;
  priceMinor: number;
  confirmationDueAt: string | null;
}>;

type Option = Readonly<{ id: string; name: string }>;

/**
 * A specialist as the board draws them: the option plus the photo their name is
 * shown beside. Kept apart from `Option` so the service, add-on and client
 * selects are not handed a field they have no use for.
 */
type Person = Readonly<{ id: string; name: string; avatar?: string | null }>;

/** Statuses that still occupy the specialist, and so still have actions. */
const LIVE_STATUSES = new Set(["pending_confirmation", "confirmed"]);

/*
 * The statuses that hold an hour, mirroring `OCCUPYING_BOOKING_STATUSES` on the
 * server. Only a cancellation gives the time back: a closed visit and a no-show
 * both happened at that hour, and offering it as free would invite a second
 * client into a slot the studio has already spent.
 */
const OCCUPYING = new Set(["pending_confirmation", "confirmed", "completed", "no_show"]);

const CANCELLATION_REASONS = ["client_request", "studio_request", "no_contact", "duplicate", "other"];

type Alternative = Readonly<{ date: string; slots: string[] }>;

type BookingPreview = {
  durationMinutes: number;
  preview:
    | {
        status: "complete";
        commission_minor: number;
        contribution_margin_minor: number;
      }
    | { status: "incomplete"; reasons: string[] };
};

/** "09:30" as minutes past midnight. The strings are already local wall clock. */
function minutesOf(clock: string) {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

export function CalendarBoard({
  monthDays,
  selected,
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
  shifts,
  buffers,
  canWrite,
  canFilterBySpecialist,
  businessType,
  currency,
  localeTag,
  locale,
}: {
  /** Every date of the month grid, in order, whole ISO weeks. */
  monthDays: readonly CalendarMonthDay[];
  /** The date the list below the month is showing. */
  selected: string;
  today: string;
  bookings: CalendarBooking[];
  locations: readonly Readonly<{ id: string; name: string; timezone: string }>[];
  specialists: readonly Person[];
  services: readonly Readonly<{ id: string; name: string; durationMinutes: number | null }>[];
  addOns: readonly Option[];
  assignments: readonly Readonly<{ specialistId: string; locationId: string }>[];
  clients: readonly Option[];
  filters: Readonly<{ location: string; specialist: string; status: string }>;
  ownSpecialistId: string | null;
  exceptions: readonly CalendarException[];
  /** The rota the day's tally measures its free time against. */
  shifts: readonly (ShiftRule & Readonly<{ locationId: string }>)[];
  /** Per location, the gap a studio keeps around each appointment. */
  buffers: readonly Readonly<{ locationId: string; before: number; after: number }>[];
  canWrite: boolean;
  canFilterBySpecialist: boolean;
  /** Whose earnings the preview under an appointment is naming. */
  businessType: BusinessType;
  currency: string;
  localeTag: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, BookingPreview | "loading" | "error">>({});
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
  ): Promise<Record<string, unknown> | false> {
    setPending(true);
    setError(null);
    setNotice(null);
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
      /*
       * The body, not just the fact of success: a cancellation answers with
       * `client_notified`, and an empty list there is the one outcome the desk
       * has to act on rather than read about later.
       */
      const body = (await response.json().catch(() => null)) as {
        data?: Record<string, unknown>;
      } | null;
      router.refresh();
      return body?.data ?? {};
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
    const result = await send(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: String(data.get("reason")),
      cancelled_by: String(data.get("cancelled_by")),
      version: booking.version,
    });
    /*
     * The appointment is off either way — this is about whether the client
     * knows. An address is written to, and a client with only a phone now gets
     * an SMS; an empty list means the card carries neither, and the only thing
     * left that can reach them is the person reading this.
     */
    if (result && Array.isArray(result.client_notified) && result.client_notified.length === 0) {
      setNotice(t("calendar.clientNotReached"));
    }
  }

  async function resendManageLink(bookingId: string) {
    if (await send(`/api/v1/bookings/${bookingId}/manage-link`, {})) {
      setNotice(t("calendar.manageLinkSent"));
    }
  }

  async function loadPreview(bookingId: string) {
    if (previews[bookingId]) return;
    setPreviews((prev) => ({ ...prev, [bookingId]: "loading" }));
    const response = await fetch(`/api/v1/bookings/${bookingId}/preview`);
    if (response.ok) {
      const body = (await response.json()) as { data: BookingPreview };
      setPreviews((prev) => ({ ...prev, [bookingId]: body.data }));
    } else {
      setPreviews((prev) => ({ ...prev, [bookingId]: "error" }));
    }
  }

  async function complete(booking: CalendarBooking, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const durationRaw = String(data.get("actual_duration") ?? "").trim();

    const payload = {
      version: booking.version,
      ...(durationRaw ? { actual_duration_minutes: Number(durationRaw) } : {}),
    };
    await send(`/api/v1/bookings/${booking.id}/complete`, payload, {
      key: keyFor(JSON.stringify({ bookingId: booking.id, ...payload })),
    });
  }

  async function completeNow(booking: CalendarBooking) {
    const payload = { version: booking.version };
    await send(`/api/v1/bookings/${booking.id}/complete`, payload, {
      key: keyFor(JSON.stringify({ bookingId: booking.id, ...payload })),
    });
  }

  /*
   * The listed day, as one run in time order.
   *
   * Appointments and blocked time in the same list, because to whoever is
   * reading it they are the same statement: this hour is spoken for. Sorted by
   * the clock rather than grouped under each master, which is the trade this
   * layout makes — a column per person was fifty pixels wide on a phone, and a
   * flat list is not, so the name rides on the card instead of heading a column
   * of them.
   */
  type DayItem =
    | { kind: "booking"; at: string; data: CalendarBooking }
    | { kind: "exception"; at: string; data: CalendarException };

  const dayItems: DayItem[] = [
    ...bookings.map((data) => ({ kind: "booking" as const, at: data.localStart, data })),
    ...exceptions.map((data) => ({ kind: "exception" as const, at: data.localStart, data })),
  ].sort((left, right) => left.at.localeCompare(right.at));

  /*
   * Whose appointment this is, on the card itself.
   *
   * The day used to stand in a column headed by its master's name and face, so
   * naming them on every card would have been a line of noise per appointment.
   * A flat list has no column to inherit it from: without this, a studio of
   * four reads as one queue belonging to nobody.
   *
   * Still withheld wherever the reader already knows whose day this is: a
   * studio of one, a Master looking at their own calendar, and anyone who has
   * narrowed the filter to a single master. In all three every card would carry
   * the same name, which is a line of noise per appointment.
   *
   * Offered the moment something on the day belongs to somebody no longer on
   * the roster, since that is the one name the reader cannot infer — the
   * roster is the live one and has to be, while the appointments deliberately
   * are not.
   */
  const namesMasters =
    ownSpecialistId === null &&
    !filters.specialist &&
    (specialists.length > 1 ||
      bookings.some((booking) => !specialists.some((person) => person.id === booking.specialistId)));

  /**
   * The master's face, drawn the way `/app/visits` draws one.
   *
   * It used to sit in the column head, which is the one piece of that layout
   * worth carrying over: a studio scanning its day recognises a photo faster
   * than it reads a name. In a flat list it rides beside the name on the card,
   * and only where the name itself is shown — a studio of one would otherwise
   * have the same face on every row.
   *
   * Nothing for an appointment whose master has been archived: the roster is
   * the live one and has to be, while the appointments deliberately are not.
   * The card still names them, which is the half that matters.
   */
  const faceOf = (specialistId: string) => {
    const person = specialists.find((candidate) => candidate.id === specialistId);
    if (!person) return null;
    return (
      <span className="avatar" aria-hidden="true">
        {person.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- a studio's own photo, not a build-time asset.
          <img src={person.avatar} alt="" />
        ) : (
          person.name.trim().slice(0, 1).toUpperCase() || "?"
        )}
      </span>
    );
  };

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

  /**
   * Whose time this screen may block out. A master blocks only their own; for
   * everybody else it is the whole catalogue.
   */
  const blockable = specialists.filter(
    (person) => ownSpecialistId === null || person.id === ownSpecialistId,
  );

  const bookable = specialists.filter((person) => {
    if (ownSpecialistId !== null && person.id !== ownSpecialistId) return false;
    const theirs = assignments.filter((link) => link.specialistId === person.id);
    return theirs.length === 0 || theirs.some((link) => link.locationId === composeLocation);
  });

  /*
   * The shortest thing the studio sells, which is what separates a window from
   * a crack: a gap nothing on the price list fits into is not an opening, and
   * counting one would put a number in the column head that nobody can act on.
   * An hour when the catalogue says nothing — a studio that has not filled it
   * in yet should not be told its whole day is free in one-minute pieces.
   */
  const shortestService = Math.min(
    ...services.map((service) => service.durationMinutes ?? Number.POSITIVE_INFINITY),
    60,
  );

  const weekdayOfDay = (() => {
    const parsed = parseLocalDate(selected);
    return parsed ? localDateWeekday(parsed) : null;
  })();

  /**
   * An appointment plus the gap the studio keeps around it.
   *
   * The buffers belong to the location, so they are read per booking rather
   * than once: a master working at two addresses is under two settings. Without
   * them a ten-minute turnaround would be offered as free time that the booking
   * engine itself refuses to fill.
   */
  const withBuffer = (start: number, end: number, locationId: string | null): Span => {
    const gap = buffers.find((entry) => entry.locationId === locationId);
    return { start: start - (gap?.before ?? 0), end: end + (gap?.after ?? 0) };
  };

  /**
   * What the studio could still sell on the listed day: the rota it works, and
   * how much of that nothing stands in.
   *
   * One line over the day rather than a figure under every name — which is what
   * the flat list costs and what it buys. «12 / 10» repeated down a row of
   * columns was four numbers to add up before answering «а когда можно?»; this
   * is the answer already added up, and it is still one person's number
   * whenever the filter is one person's.
   *
   * Computed per master and only then summed, because free time is a property
   * of one person on one date. Two masters each free from 10:00 to 11:00 is an
   * hour the studio can sell twice; merging their rotas first would report it
   * as one, and subtracting bookings from a merged rota would let one master's
   * appointment eat the other's morning.
   */
  const dayTally = (() => {
    if (weekdayOfDay === null) return { shift: 0, free: 0 };

    let shift = 0;
    let free = 0;

    for (const specialistId of new Set(shifts.map((rule) => rule.specialistId))) {
      const rota = rotaFor(shifts, specialistId, selected, weekdayOfDay);
      if (rota.length === 0) continue;

      /*
       * Blocked intervals count as fully as appointments — a holiday is not
       * time anybody can be booked into — while a cancellation gives its hour
       * back, which is why the bookings are filtered by `OCCUPYING` rather than
       * taken whole.
       */
      const taken: Span[] = [
        ...bookings
          .filter(
            (booking) => booking.specialistId === specialistId && OCCUPYING.has(booking.status),
          )
          .map((booking) =>
            withBuffer(
              minutesOf(booking.localStart),
              minutesOf(booking.localEnd),
              booking.locationId,
            ),
          ),
        ...exceptions
          .filter((exception) => exception.specialistId === specialistId)
          .map((exception) => ({
            start: minutesOf(exception.localStart),
            end: minutesOf(exception.localEnd),
          })),
      ];

      /*
       * The shift and what is left of it, in hours rather than in openings: an
       * opening is not a fixed quantity — how many a day holds depends on the
       * length of the service being booked into it, and the calendar has no
       * service selected. Hours are the same number whatever anybody books,
       * they add up across masters, and they are what
       * `practical_capacity_basis_points` already measures a studio in.
       */
      shift += totalMinutes(rota.map((rule) => ({ start: rule.startMinute, end: rule.endMinute })));
      // Summed over the windows rather than over the shift less the bookings:
      // a gap too short to sell is not free time, and `freeWindows` has already
      // dropped those.
      free += totalMinutes(freeWindows(rota, taken, shortestService));
    }

    return { shift, free };
  })();

  /**
   * The month and the year the grid is drawing, each one a list to choose from.
   *
   * Read off the selected date rather than passed down, because they are the
   * same fact: the grid is built around the anchor, and the anchor is the day
   * the list below is showing.
   *
   * Two controls rather than one list of «сентябрь 2026 г.». A single list has
   * to stop somewhere, and wherever it stops is a month nobody can reach; split,
   * the months are always all twelve and only the years are a list — a short
   * one, and one that can be widened without touching the other half.
   */
  const anchor = parseLocalDate(selected) ?? { year: 1970, month: 1, day: 1 };

  /*
   * The fifteenth at midday, not the first at midnight. `toLocaleDateString`
   * reads an instant in the browser's own zone, and a first-of-the-month
   * instant is within a few hours of the month before — far enough west and
   * every name in this list would be off by one.
   */
  const monthNames = Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(anchor.year, index, 15, 12)).toLocaleDateString(localeTag, { month: "long" }),
  );

  /*
   * Two years back and one forward, which is where the work is: a studio reads
   * back over its own records and books forward only as far as it takes
   * bookings, which `max_advance_days` caps in months rather than years.
   *
   * Taken from `today` rather than from the clock. This renders on the server
   * and hydrates in the browser, and `new Date()` on both sides of that is two
   * readings — on New Year's Eve, of two different years.
   *
   * The anchor's own year joins the list wherever it falls, so a link somebody
   * kept from further back still shows the year it is actually on rather than
   * silently displaying a different one.
   */
  const thisYear = Number(today.slice(0, 4));
  const years = [
    ...new Set([anchor.year, thisYear - 2, thisYear - 1, thisYear, thisYear + 1]),
  ].sort((left, right) => left - right);

  /**
   * The listed day, spelled out — the name of the panel below the grid rather
   * than a heading printed inside it. The grid says which date is chosen by
   * filling it in, and a heading repeating that was the same fact twice.
   */
  const dayLabel = new Date(`${selected}T12:00:00`).toLocaleDateString(localeTag, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  /**
   * «Пн Вт Ср…», taken from the grid's own first week rather than written out.
   *
   * The grid always starts on a Monday, so its first seven dates are one of
   * each weekday in order — which means the row of headings cannot drift out of
   * step with the columns beneath it, whatever a locale spells them.
   */
  const weekdayNames = monthDays
    .slice(0, 7)
    .map((day) =>
      new Date(`${day.date}T12:00:00`).toLocaleDateString(localeTag, { weekday: "short" }),
    );

  return (
    <>
      <nav className="calendar-toolbar" aria-label={t("calendar.period")}>
        <div className="calendar-where">
          {/*
            Whose calendar this is, open on the bar rather than folded behind a
            «Фильтры» button.

            It is the only filter with a control now, and it is the one a studio
            actually reaches for — «покажи день Ирины» is a question asked many
            times a day, where the address and the status were asked once and
            then left alone. Folded away it cost two taps every time and, on a
            phone, a panel that opened off the side of the screen.

            First in the bar, because it is the widest thing it says: the month
            after it is a statement about the calendar this select has already
            chosen.

            Navigated rather than submitted: the grid's own dates are `<Link>`s
            through `queryFor`, and routing this the same way keeps one
            mechanism instead of a form that would need every other filter
            copied into hidden fields to avoid dropping them.
          */}
          {canFilterBySpecialist && specialists.length > 1 && (
            <select
              className="calendar-specialist"
              aria-label={t("calendar.specialist")}
              value={filters.specialist}
              onChange={(event) =>
                router.push(
                  queryFor({ ...filters, specialist: event.target.value, date: selected }),
                )
              }
            >
              <option value="">{t("calendar.allSpecialists")}</option>
              {specialists.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}

          {/*
            The way back, and the one control of the old set that was not a
            second way to do something.

            The arrows went because the month select already steps a month, and
            they stepped exactly one. This does something neither the grid nor
            the selects can: today's date wears a ring in the grid and can be
            pressed — but only while today is in the month on screen. From March
            2027 the way home is two changes of two fields, each its own trip to
            the server, and this is one.
          */}
          <Link className="secondary-button" href={queryFor({ ...filters, date: today })}>
            {t("calendar.today")}
          </Link>

          {/*
            The month, which is what the arrows now step and what the grid
            below is drawing. A date was only ever needed here while the board
            was one day wide; the day the list is showing is named over the
            list itself, where the reader is when they need it.
          */}
          <span className="calendar-period">
            <select
              aria-label={t("calendar.month")}
              value={anchor.month}
              onChange={(event) =>
                router.push(
                  queryFor({
                    ...filters,
                    date: dateIn(selected, { month: Number(event.target.value) }),
                  }),
                )
              }
            >
              {monthNames.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label={t("calendar.year")}
              value={anchor.year}
              onChange={(event) =>
                router.push(
                  queryFor({
                    ...filters,
                    date: dateIn(selected, { year: Number(event.target.value) }),
                  }),
                )
              }
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </span>

        </div>

        <div className="calendar-tools">
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
      {notice && <p className="booking-manage-notice" role="status">{notice}</p>}

      {/*
        The month, as navigation.

        Every date of the grid is a link to itself, so the day below changes by
        the same mechanism the arrows and «Сегодня» already use: a query string
        the server reads. That is a round trip per date, and it is the right
        trade — the alternative is shipping a month of appointments to the
        browser so a click can filter them locally, which is a month of names
        and phone numbers sent to render a list of one day. It also leaves the
        date in the address, so a day can be sent to somebody.

        The marks are `aria-hidden`: they are a picture of the count, and the
        count is already in the cell's own words underneath them.
      */}
      <section className="panel calendar-month" aria-label={`${monthNames[anchor.month - 1]} ${anchor.year}`}>
        <div className="calendar-weekdays" aria-hidden="true">
          {weekdayNames.map((name, index) => (
            <span key={index}>{name}</span>
          ))}
        </div>

        <div className="calendar-cells">
          {monthDays.map((day) => (
            <Link
              key={day.date}
              href={queryFor({ ...filters, date: day.date })}
              className={[
                "calendar-cell",
                day.outside ? "is-outside" : "",
                day.date === today ? "is-today" : "",
                day.date === selected ? "is-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-current={day.date === selected ? "date" : undefined}
            >
              <span className="calendar-cell-date" aria-hidden="true">
                {Number(day.date.slice(8))}
              </span>
              {/*
                Drawn even when the day is empty. The cell centres what is in
                it, so a date with marks and a date without put their numbers on
                different lines unless the row is always there — and a month
                whose numbers do not line up across a week is harder to read
                than one with no marks at all.
              */}
              <span className="calendar-marks" aria-hidden="true">
                {day.marks.map((status, index) => (
                  <i key={index} className={`calendar-mark status-${status}`} />
                ))}
                {day.total > day.marks.length && (
                  <b className="calendar-more">+{day.total - day.marks.length}</b>
                )}
              </span>
              <span className="sr-only">
                {new Date(`${day.date}T12:00:00`).toLocaleDateString(localeTag, {
                  day: "numeric",
                  month: "long",
                })}
                {day.total > 0 && ` · ${t("calendar.dayEntries", { count: String(day.total) })}`}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/*
        The day itself is not printed over the list.

        It was a heading here — «пятница, 11 сентября» — and it said what the
        grid directly above had just said by filling that date in. The panel
        keeps the date as its accessible name instead: a reader with the screen
        in front of them has it in the cell, and one without it still gets the
        region announced by the day it covers rather than as an unnamed box.
      */}
      <section className="panel calendar-daylist" aria-label={dayLabel}>
        {/*
          The day at a glance: the shift the studio works, and how many of those
          hours are still open. Two figures rather than one because they answer
          different questions — a full day and a day nobody works both have "0"
          somewhere, and which zero it is is the whole point.

          Written out, where it used to be «10 / 5,5» with the words kept for
          screen readers only. That pair sat in a master's column head, which
          named it; over a flat list it names nothing, and two bare numbers and
          a slash are a thing the reader has to be told once and then remember.
          The sentence is the same string the screen reader was already getting,
          so it is one string in three languages rather than a new legend.
        */}
        {dayTally.shift > 0 && (
          <p className="calendar-tally">
            {t("calendar.tally", {
              shift: toHalfHours(dayTally.shift).toLocaleString(localeTag),
              free: toHalfHours(dayTally.free).toLocaleString(localeTag),
            })}
          </p>
        )}

        {dayItems.length === 0 ? (
          <p className="muted">{t("calendar.emptyDay")}</p>
        ) : (
          <ul className="calendar-list">
            {dayItems.map((item) => {
              if (item.kind === "exception") {
                const exc = item.data;
                return (
                    <li key={exc.id} className="calendar-entry status-blocked">
                      <details>
                        <summary>
                          <span className="calendar-time">
                            {exc.localStart}–{exc.localEnd}
                          </span>
                          <span className="calendar-what">
                            {t("calendar.blockedLabel")}
                            {exc.reason && <span className="unit-hint">{exc.reason}</span>}
                          </span>
                          {namesMasters && (
                            <span className="calendar-who calendar-master">
                              {faceOf(exc.specialistId)}
                              {exc.specialistName}
                            </span>
                          )}
                        </summary>
                        <div className="calendar-detail">
                          <p className="muted">
                            {exc.locationName ?? t("calendar.allLocations")}
                            {" · "}
                            {exc.specialistName}
                          </p>
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
                >
                  <details
                    onToggle={(event) => {
                      if (
                        event.currentTarget.open &&
                        booking.status === "confirmed"
                      ) {
                        loadPreview(booking.id);
                      }
                    }}
                  >
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
                        {namesMasters && (
                          <span className="unit-hint calendar-master">
                            {faceOf(booking.specialistId)}
                            {booking.specialistName}
                          </span>
                        )}
                      </span>
                      {/* Never colour alone (section 7.8): the status is words. */}
                      <span className="calendar-status">
                        {t(`bookingStatus.${booking.status}` as MessageKey)}
                      </span>
                    </summary>

                    <div className="calendar-detail">
                      {/*
                        Which card this visit joins, when it is not the name
                        above. A public request keeps the client's record as the
                        studio wrote it and carries its own name instead, so the
                        two can differ — one number, a household — and the desk
                        has to be able to see both: who is coming, and whose
                        history this visit will be filed under.
                      */}
                      {booking.clientCardName && (
                        <p className="muted">
                          {t("calendar.clientCard", { name: booking.clientCardName })}
                        </p>
                      )}
                      <p className="muted">
                        {booking.locationName} · {booking.specialistName} · {money(booking.priceMinor)}
                        {/*
                          The number, as something to press rather than to read
                          out to yourself and type into a phone. «Клиент
                          опаздывает» and «клиент не отвечает» are both answered
                          by reaching the client, and this card is where the desk
                          is standing when either happens — by calling, or by
                          writing where somebody who does not pick up will read
                          it. See `ClientContact`.

                          `normalizedPhone` is safe in the href as it stands:
                          `normalizePhone` in `domain/phone` strips every space,
                          dash and bracket a human might type and returns
                          `+<код><номер>`, which is what `tel:` wants.

                          Absent for an Analyst — the column arrives null under
                          `exclude_pii`, so the link cannot be built from data
                          that is not there.
                        */}
                        {booking.clientPhone && (
                          <>
                            {" · "}
                            <ClientContact phone={booking.clientPhone} locale={locale} />
                          </>
                        )}
                      </p>
                      {/*
                        The zone used to head this line — «Время локации
                        (Europe/Chisinau)» over every card, on a screen where
                        every time already is that location's. It named the
                        address it belongs to two lines up, so the paragraph is
                        now the deadline alone, and goes when there is none.
                      */}
                      {booking.confirmationDueAt && (
                        <p className="muted">
                          {t("calendar.answerBy", {
                            when: new Date(booking.confirmationDueAt).toLocaleString(localeTag, {
                              timeZone: booking.timezone,
                            }),
                          })}
                        </p>
                      )}

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
                              {previews[booking.id] === "loading" && (
                                <p className="muted">{t("calendar.loadingPreview")}</p>
                              )}
                              {typeof previews[booking.id] === "object" && previews[booking.id] !== null && (
                                (() => {
                                  const preview = (previews[booking.id] as BookingPreview).preview;
                                  return (
                                    <div className="visit-card-metrics calendar-completion-preview">
                                      {preview.status === "complete" ? (
                                        <>
                                          <div>
                                            <span>{t(businessLabel.visitEarnings[businessType])}</span>
                                            <strong>−{money(preview.commission_minor)}</strong>
                                          </div>
                                          <div>
                                            <span>{t("visits.keeps")}</span>
                                            <strong>{money(preview.contribution_margin_minor)}</strong>
                                          </div>
                                        </>
                                      ) : (
                                        <p className="warning-banner">
                                          {preview.reasons
                                            .map((reason) => t(`reason.${reason}` as MessageKey))
                                            .join("; ")}
                                        </p>
                                      )}
                                    </div>
                                  );
                                })()
                              )}
                              <button
                                type="button"
                                className="primary-button"
                                disabled={pending}
                                onClick={() => completeNow(booking)}
                              >
                                {pending ? t("common.saving") : t("calendar.complete")}
                              </button>
                              <details
                                className="calendar-subform"
                              >
                                <summary>{t("closeVisit.modifyDuration")}</summary>
                                <form className="inline-form" onSubmit={(e) => complete(booking, e)}>
                                  {(() => {
                                    const r = previews[booking.id];
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
                                          placeholder={dur === undefined ? undefined : String(dur)}
                                        />
                                      </label>
                                    );
                                  })()}
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

                          {booking.clientId && (
                            <details className="calendar-subform">
                              <summary>{t("calendar.resendManageLink")}</summary>
                              <p className="muted">{t("calendar.resendManageLinkHint")}</p>
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={pending}
                                onClick={() => resendManageLink(booking.id)}
                              >
                                {pending ? t("common.saving") : t("calendar.resendManageLinkConfirm")}
                              </button>
                            </details>
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
                                {/*
                                  The person this appointment is already with,
                                  even when they no longer work here.

                                  The list is live masters; the appointments
                                  above are not filtered by the archive, and
                                  they must not be — a client's Tuesday does
                                  not disappear because the studio parted with
                                  somebody. So a booking whose master was
                                  archived had a `defaultValue` matching no
                                  option, and a browser answers that by
                                  selecting the first one: moving the time
                                  moved the appointment to whoever happened to
                                  head the list. Naming them keeps «не трогал
                                  это поле» meaning «ничего не поменялось».
                                */}
                                <select name="specialist_id" defaultValue={booking.specialistId}>
                                  {specialistOptions(blockable, {
                                    id: booking.specialistId,
                                    name: booking.specialistName,
                                  }).map((person) => (
                                    <option key={person.id} value={person.id}>
                                      {person.archived
                                        ? t("specialists.archivedOption", { name: person.name })
                                        : person.name}
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

      {canWrite && bookable.length > 0 && locations.length > 0 && services.length > 0 && (
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
            {/*
              The address and the master are asked for only where there is a
              choice; with one of each the two selects were four taps of
              ceremony in front of every appointment a studio of one wrote by
              hand. Hidden rather than dropped, because the endpoint still
              needs both and this form is read from `FormData`.
            */}
            {locations.length > 1 ? (
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
            ) : (
              <input type="hidden" name="location_id" value={composeLocation} />
            )}
            {bookable.length > 1 ? (
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
            ) : (
              <input type="hidden" name="specialist_id" value={bookable[0]?.id ?? ""} />
            )}
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
              <input type="date" name="date" defaultValue={selected} required />
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

      {/*
        `blockable`, not the whole catalogue. They differ for exactly one
        person: a master whose account has no specialist card — a studio-only
        state, since a solo workspace is created with its owner's card. Gated
        on the roster, this drew a form whose only field had nothing to put in
        it, and the visible-but-dead select that used to make that obvious is
        now a hidden input that would post an empty id.
      */}
      {canWrite && blockable.length > 0 && (
        <details className="panel calendar-compose calendar-block-time">
          <summary>
            <h2>{t("calendar.blockTime")}</h2>
          </summary>
          <p className="muted">{t("calendar.blockHint")}</p>
          <form className="inline-form" onSubmit={blockTime}>
            {/*
              The same rule as the appointment form above. A master's list is
              already narrowed to themselves, so for them there was never a
              choice here either — one branch covers both.
            */}
            {blockable.length > 1 ? (
              <label>
                {t("calendar.specialist")}
                <select name="specialist_id" required defaultValue={ownSpecialistId ?? undefined}>
                  {blockable.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <input type="hidden" name="specialist_id" value={blockable[0]?.id ?? ""} />
            )}
            {/*
              «Все адреса» and the only address are the same block written two
              ways, so with one address the choice is offered as two answers to
              one question. The wider of the two is what an empty value means,
              and it is what a studio of one wants either way.
            */}
            {locations.length > 1 ? (
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
            ) : (
              <input type="hidden" name="location_id" value="" />
            )}
            <label>
              {t("calendar.date")}
              <input type="date" name="date" defaultValue={selected} required />
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

/**
 * The same date in another month or year, or the last day when there is no
 * same.
 *
 * «31 января» has no counterpart in February, and a calendar that normalizes it
 * lands in March — two months of movement from one change of one field. The end
 * of the month being entered is what a reader means by "this date, over there",
 * and it is what makes the step reversible: January's 31st becomes February's
 * 28th and comes back as January's 28th, which is a day, rather than a month
 * nobody asked for.
 */
function dateIn(date: string, part: Readonly<{ year?: number; month?: number }>) {
  const parsed = parseLocalDate(date);
  if (!parsed) return date;

  const year = part.year ?? parsed.year;
  const month = part.month ?? parsed.month;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return formatLocalDate({ year, month, day: Math.min(parsed.day, lastDay) });
}
