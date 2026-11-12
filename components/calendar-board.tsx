"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  clockAt,
  freeSlotsOfDay,
  freeWindows,
  rotaFor,
  splitIntoSlots,
  toHalfHours,
  totalMinutes,
  type BusySpan,
  type FreeSlot,
  type ShiftRule,
  type Span,
} from "@/components/calendar-free-time";
import { groupDayByMaster } from "@/components/calendar-day-groups";
import { BookingSlotPicker } from "@/components/booking-slot-picker";
import { ClientPicker, type PickableClient } from "@/components/client-picker";
import { DayMoreTile } from "@/components/day-more-tile";
import { DayStrip } from "@/components/day-strip";
import { MasterPicker } from "@/components/master-picker";
import { slotsUrl } from "@/components/booking-slots";
import { TimeMoreTile } from "@/components/time-more-tile";
import { ServiceRows } from "@/components/service-rows";
import { toServicesPayload, type ServiceLine } from "@/components/service-lines-field";
import { ClientContact } from "@/components/client-contact";
import { NextVisit } from "@/components/next-visit";
import { SlotFillPanel } from "@/components/slot-fill-panel";
import { PaidField, TipField, tipMinorOf, toMajorUnits, toMinorUnits } from "@/components/paid-field";
import type { ContactChannelMarks } from "@/domain/contact-channels";
import { StatusIcon, ToolIcon } from "@/components/icons";
import {
  formatLocalDate,
  formatLocalTime,
  localDateWeekday,
  localToUtc,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
  toZonedParts,
} from "@/domain/timezone";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { businessLabel, type BusinessType } from "@/i18n/business-labels";
import { specialistOptions } from "@/lib/specialist-options";
import { type MessageKey } from "@/i18n/t";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { formatLongDate, formatMoneyMinor } from "@/lib/format";

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
  /** What anybody has said about reaching them; empty when nobody has. */
  clientChannels: ContactChannelMarks;
  /** The studio's note about the client; null for none, and for an Analyst. */
  clientNotes: string | null;
  serviceName: string;
  extraLines: number;
  priceMinor: number;
  confirmationDueAt: string | null;
}>;

/**
 * A visit closed by hand, with no appointment behind it (`domain/calendar-visits`).
 *
 * Drawn among the appointments on the hours it took, so the day it happened no
 * longer reads «Записей нет». It is done: there is nothing to confirm, move or
 * cancel, so its card carries the facts and the way to the visit itself.
 */
export type CalendarVisit = Readonly<{
  id: string;
  localDate: string;
  localStart: string;
  localEnd: string;
  specialistId: string;
  specialistName: string;
  clientName: string | null;
  serviceName: string;
  extraLines: number;
  /** The newest snapshot's revenue; null when the visit has none. */
  revenueMinor: number | null;
}>;

/**
 * A specialist as the board draws them: an id and a name plus the photo the name
 * is shown beside.
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

/** The months the month list reaches either side of the one on screen. */
const MONTHS_BACK = 24;
const MONTHS_FORWARD = 12;

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
  now,
  bookings,
  visits = [],
  locations,
  specialists,
  services,
  offers,
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
  studio,
  focusBookingId = null,
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
  /**
   * The instant the page was drawn at, as a string. Read from the server rather
   * than from the browser's clock so the render and the hydration agree: a
   * free window that begins in the past would otherwise flicker out a moment
   * after it appeared.
   */
  now: string;
  bookings: CalendarBooking[];
  /** Visits of the listed day closed without an appointment. */
  visits?: readonly CalendarVisit[];
  locations: readonly Readonly<{ id: string; name: string; timezone: string }>[];
  specialists: readonly Person[];
  services: readonly Readonly<{ id: string; name: string; durationMinutes: number | null; priceMinor: number | null }>[];
  /**
   * Who does which service, with their own price and length where they have
   * one. A master with no rows does everything: the studio of one has not had
   * to list its own catalogue, and the server reads it the same way.
   */
  offers: readonly Readonly<{
    specialistId: string;
    serviceId: string;
    priceMinor: number | null;
    durationMinutes: number | null;
  }>[];
  /** `serviceIds` null: offered with any service, as the calendar always has. */
  addOns: readonly Readonly<{
    id: string;
    name: string;
    priceDeltaMinor: number;
    durationDeltaMinutes: number;
    serviceIds: readonly string[] | null;
  }>[];
  assignments: readonly Readonly<{ specialistId: string; locationId: string }>[];
  clients: readonly PickableClient[];
  filters: Readonly<{ location: string; specialist: string; status: string }>;
  ownSpecialistId: string | null;
  /**
   * An appointment to open on arrival, with its «Другая сумма или
   * длительность» form: what «Закройте прошедшие записи» links to when the
   * client paid something other than the «Итого».
   */
  focusBookingId?: string | null;
  exceptions: readonly CalendarException[];
  /** The rota the day's tally measures its free time against. */
  shifts: readonly (ShiftRule & Readonly<{ locationId: string }>)[];
  /**
   * Per location, the gap a studio keeps around each appointment, and the step
   * its openings are cut into slots by — the address's «Шаг слотов».
   */
  buffers: readonly Readonly<{ locationId: string; before: number; after: number; step: number }>[];
  canWrite: boolean;
  canFilterBySpecialist: boolean;
  /** The studio's own face, which is the «all masters» button of the filter. */
  studio: Readonly<{ name: string; logo: string | null }>;
  /** Whose earnings the preview under an appointment is naming. */
  businessType: BusinessType;
  currency: string;
  localeTag: string;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = useTranslator(locale);
  const register = useRegister();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The appointment cancelled on this page, whose freed hour is offered at once. */
  const [justCancelled, setJustCancelled] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, BookingPreview | "loading" | "error">>({});
  /** «Клиент заплатил» per appointment, as typed; absent until somebody types. */
  const [paidInputs, setPaidInputs] = useState<Record<string, string>>({});
  const [tipInputs, setTipInputs] = useState<Record<string, string>>({});
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
        ? getErrorMessage(code, failure?.error?.message ?? t("common.saveFailed"), locale, register)
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

    if (composeLinesNow.length === 0) return setError(t("calendar.pickService"));

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
      services: toServicesPayload(composeLinesNow),
      ...(clientId ? { client_id: clientId } : {}),
      starts_at: when.toISOString(),
    };

    const created = await send("/api/v1/bookings", payload, {
      key: keyFor(JSON.stringify(payload)),
      zone: timezoneOf(locationId),
    });
    if (created) {
      setComposeOpen(false);
      setComposeTime("");
      setComposeLines([]);
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
    // The hour is back: the same desk can still fill it, so ask whom to write to.
    if (result) setJustCancelled(booking.id);
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
    // Untouched means the booking's «Итого», which is what omitting it means
    // to the server; a typed amount is sent as typed.
    const typed = paidInputs[booking.id];
    const paidMinor = typed === undefined ? null : toMinorUnits(typed);
    const tipMinor = tipMinorOf(tipInputs[booking.id] ?? "");
    if (tipMinor === null) return;

    const payload = {
      version: booking.version,
      ...(durationRaw ? { actual_duration_minutes: Number(durationRaw) } : {}),
      ...(paidMinor !== null ? { paid_minor: paidMinor } : {}),
      ...(tipMinor ? { tip_minor: tipMinor } : {}),
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
   * Whose hours these are: the day cut into one run per master, each headed by
   * their face and name.
   *
   * The name used to ride on every card of a flat list, free ones included, so
   * a master with three open hours had it three times in a row. Under a heading
   * it is said once, and the cards say only what is booked or open.
   *
   * Not done wherever the reader already knows whose day this is: a studio of
   * one, a Master looking at their own calendar, and anyone who has narrowed
   * the filter to a single master. A heading over the only run there is would
   * be a line of noise.
   *
   * Done the moment something on the day belongs to somebody no longer on the
   * roster, since that is the one name the reader cannot infer — the roster is
   * the live one and has to be, while the appointments deliberately are not.
   */
  const byMaster =
    ownSpecialistId === null &&
    !filters.specialist &&
    (specialists.length > 1 ||
      [...bookings, ...visits].some(
        (entry) => !specialists.some((person) => person.id === entry.specialistId),
      ));

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
  // What the new appointment is made of: one service, or several in one sitting.
  // Nothing is chosen for the desk — the first service on the list is a guess, and
  // a wrong one is booked as readily as a right one — except where there is only
  // one service to choose, which `composeLinesNow` takes.
  const [composeLines, setComposeLines] = useState<ServiceLine[]>([]);

  /*
   * The appointment form lives in a window, opened from the round «+». Its
   * date, master and time are held here because the free times shown above the
   * time field are a question about all three.
   */
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDate, setComposeDate] = useState(selected);
  // null: the master whose calendar is open; an id: the one picked in the form; "": asked to choose again.
  const [composeSpecialist, setComposeSpecialist] = useState<string | null>(null);
  const [composeTime, setComposeTime] = useState("");
  const composeCard = useRef<HTMLDivElement>(null);

  /**
   * Opens the window on the day the calendar is showing: the desk is looking at
   * a date because that is the one it is about to book, so asking for it again
   * would be the first thing the form made it do.
   *
   * With a `preset` — an opening on the list the desk pressed — the master, the
   * address and the time are the opening's too: pressing «12:00–14:00, Анна»
   * has already answered all three, and the form asking them again would be the
   * second thing it made the desk do.
   */
  function openCompose(preset?: Readonly<{ locationId: string; specialistId: string; time: string }>) {
    setError(null);
    setNotice(null);
    setAlternatives({ zone: "UTC", entries: [] });
    setComposeDate(selected);
    setComposeTime(preset?.time ?? "");
    setComposeSpecialist(preset?.specialistId ?? null);
    if (preset) setComposeLocation(preset.locationId);
    setComposeOpen(true);
    // The form is the first thing on the page, so the page is taken to it: from
    // further down it would open above the screen, with nothing to say so.
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function closeCompose() {
    setComposeOpen(false);
    setError(null);
    setAlternatives({ zone: "UTC", entries: [] });
  }

  /*
   * Two ways in that are not this page's own button. The phone's «+»
   * (`components/quick-actions.tsx`) links to `#new-booking` by full path, and
   * arriving from another page lands with that hash in the address; both end in
   * the same window. Delegated on `document` because the anchor is rendered by
   * the shell, which is out of scope of this component.
   *
   * The click is taken in the capture phase and stopped, so the link never
   * navigates. Followed, it would load `/app/calendar` without the query: the
   * day and the master the desk was looking at would be swapped for today and
   * everyone, under a window that is about to book into the old ones. The
   * shell's menu is closed here for the same reason — its own handler no longer
   * sees the click.
   *
   * The hash is dropped once it has been acted on: left in the address, a
   * reload would open the window again on a page the desk had just closed it on.
   */
  const openComposeRef = useRef(openCompose);
  useEffect(() => {
    openComposeRef.current = openCompose;
  });

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest(
        'a[href="#new-booking"], a[href="/app/calendar#new-booking"]',
      );
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      document.querySelectorAll<HTMLDetailsElement>("details.quick-actions[open]").forEach((menu) => {
        menu.open = false;
      });
      openComposeRef.current();
    }

    document.addEventListener("click", onClick, true);
    if (location.hash === "#new-booking") {
      openComposeRef.current();
      history.replaceState(history.state, "", location.pathname + location.search);
    }
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!composeOpen) return;
    // Without `preventScroll` the browser scrolls the card flush to the top of
    // its scroll box, and the room kept above it is scrolled away at once.
    composeCard.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeCompose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [composeOpen]);

  /*
   * Opened once, on arrival, rather than held open: after this it is the
   * reader's card to close. The outer `<details>` opening is what loads the
   * margin preview, exactly as a tap on it would.
   */
  useEffect(() => {
    if (!focusBookingId) return;
    const entry = document.getElementById(`booking-${focusBookingId}`);
    const card = entry?.querySelector<HTMLDetailsElement>(":scope > details");
    if (!entry || !card) return;
    card.open = true;
    const modify = card.querySelector<HTMLDetailsElement>("details.calendar-subform");
    if (modify) modify.open = true;
    entry.scrollIntoView({ block: "center" });
    modify?.querySelector<HTMLInputElement>('input[name="paid"]')?.focus({ preventScroll: true });
  }, [focusBookingId]);

  /**
   * Whose appointments this screen may move work between. A master moves only
   * their own; for everybody else it is the whole catalogue.
   */
  const reassignable = specialists.filter(
    (person) => ownSpecialistId === null || person.id === ownSpecialistId,
  );

  const bookable = specialists.filter((person) => {
    if (ownSpecialistId !== null && person.id !== ownSpecialistId) return false;
    const theirs = assignments.filter((link) => link.specialistId === person.id);
    return theirs.length === 0 || theirs.some((link) => link.locationId === composeLocation);
  });

  // The chosen master, or the first one offered when the address changed under
  // them and they no longer work there.
  //
  // Whose calendar is open comes first: the desk looking at one master's day is
  // almost always booking that master, so the form opens on them and does not ask.
  // With everybody on screen nobody is chosen for the desk — a first master
  // picked by default would be a decision nobody made — and the form asks whom
  // before it shows anything that depends on the answer. A studio of one has no
  // one to ask. When the chosen master cannot be booked at the address the form
  // is on, the form asks again.
  const chosenSpecialist =
    bookable.find((person) => person.id === (composeSpecialist ?? filters.specialist)) ??
    (bookable.length === 1 ? bookable[0] : null);
  const composeSpecialistId = chosenSpecialist?.id ?? "";

  /*
   * What this master does, at their prices. The price list is the studio's; the
   * master's own rows narrow it and may restate a price or a length. No rows is
   * everything, as for the server, which refuses a service outside a non-empty
   * list — so a service offered here that the master does not do would only be
   * found out at «Записать».
   */
  const theirOffers = offers.filter((offer) => offer.specialistId === composeSpecialistId);
  const offeredServices = services
    .filter((service) => theirOffers.length === 0 || theirOffers.some((offer) => offer.serviceId === service.id))
    .map((service) => {
      const own = theirOffers.find((offer) => offer.serviceId === service.id);
      const price = own?.priceMinor ?? service.priceMinor;
      return {
        id: service.id,
        name: service.name,
        durationMinutes: own?.durationMinutes ?? service.durationMinutes,
        priceMinor: price ?? undefined,
      };
    });
  // The sitting as the form shows it: what was chosen that this master does. A
  // service the new master does not do drops out on a change of master; with
  // nothing left, the only service on offer is taken, and otherwise none is.
  const composeLinesNow: ServiceLine[] = (() => {
    const kept = composeLines.filter((line) => offeredServices.some((service) => service.id === line.serviceId));
    if (kept.length === 0 && offeredServices.length === 1) return [{ serviceId: offeredServices[0].id, addOnIds: [] }];
    return kept;
  })();

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
        // A visit closed by hand took its hours as surely as a completed
        // appointment did. It names no address, so it carries no buffer; one
        // running past midnight takes the rest of this day.
        ...visits
          .filter((visit) => visit.specialistId === specialistId)
          .map((visit) => {
            const start = minutesOf(visit.localStart);
            const end = minutesOf(visit.localEnd);
            return { start, end: end < start ? 24 * 60 : end };
          }),
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
   * What is still open on the listed day: each gap in a master's day cut into
   * slots of the address's step, one card per slot.
   *
   * Shown to whoever can write an appointment into it, and only on a calendar
   * that shows everything: under a status filter the appointments that stand in
   * a gap may be the ones filtered out, and a card offering an hour somebody is
   * already sitting in is worse than no card.
   *
   * The same busy hours the tally above counts, so the cards add up to «свободно
   * N ч»: an appointment and the buffer round it, a visit closed by hand, and a
   * block — which takes the hour from one address, or from all of them.
   */
  const freeSlots: FreeSlot[] = (() => {
    if (!canWrite || filters.status || weekdayOfDay === null) return [];

    const roster =
      ownSpecialistId !== null
        ? [ownSpecialistId]
        : filters.specialist
          ? [filters.specialist]
          : specialists.map((person) => person.id);
    const people = roster.filter((id) => specialists.some((person) => person.id === id));

    const busy: BusySpan[] = [
      ...bookings
        .filter((booking) => OCCUPYING.has(booking.status))
        .map((booking) => ({
          specialistId: booking.specialistId,
          locationId: null,
          span: withBuffer(minutesOf(booking.localStart), minutesOf(booking.localEnd), booking.locationId),
        })),
      ...visits.map((visit) => {
        const start = minutesOf(visit.localStart);
        const end = minutesOf(visit.localEnd);
        return {
          specialistId: visit.specialistId,
          locationId: null,
          span: { start, end: end < start ? 24 * 60 : end },
        };
      }),
      ...exceptions.map((exception) => ({
        specialistId: exception.specialistId,
        locationId: exception.locationId,
        span: { start: minutesOf(exception.localStart), end: minutesOf(exception.localEnd) },
      })),
    ];

    // «Now» is a different wall-clock time at each address, and a day is over at
    // one while it is still going at another.
    const instant = new Date(now);
    const notBefore = (locationId: string) => {
      const place = toZonedParts(instant, timezoneOf(locationId));
      const date = formatLocalDate({ year: place.year, month: place.month, day: place.day });
      if (selected < date) return 24 * 60;
      return selected === date ? place.minutes : 0;
    };

    /*
     * Only where the master is actually placed. A new card is written with a
     * default week at every address the studio has, before anybody has said
     * where they work, so the rota alone offers a master at an address they are
     * not at — the same reading `bookable` gives the form: no assignments at all
     * is a studio that has not filled them in, and means everywhere. And only
     * the addresses still open, for the same reason an archived master is not
     * offered.
     */
    const placed = shifts.filter((rule) => {
      if (!locations.some((place) => place.id === rule.locationId)) return false;
      const theirs = assignments.filter((link) => link.specialistId === rule.specialistId);
      return theirs.length === 0 || theirs.some((link) => link.locationId === rule.locationId);
    });

    const openings = freeSlotsOfDay({
      shifts: placed,
      specialistIds: people,
      locationId: filters.location || null,
      date: selected,
      weekday: weekdayOfDay,
      busy,
      minMinutes: shortestService,
      notBefore,
    });

    // Cut by each address's own step, so the list offers as many places as the
    // public page does for the same time. An address with no settings row keeps
    // the column's default of an hour.
    return splitIntoSlots(openings, (locationId) => buffers.find((entry) => entry.locationId === locationId)?.step ?? 60);
  })();

  /*
   * The listed day, in time order.
   *
   * Appointments, blocked time and the openings between them in the same list,
   * because to whoever is reading it they are the same statement about an hour:
   * either it is spoken for, or it is there to be sold. Rows rather than a
   * column per person, which was fifty pixels wide on a phone; in a studio the
   * rows are then cut into one run per master (`byMaster`).
   *
   * An opening sorts after whatever begins at the same minute: two masters, one
   * with a client at 12:00 and the other free from 12:00, read in that order.
   */
  type DayItem =
    | { kind: "booking"; at: string; data: CalendarBooking }
    | { kind: "visit"; at: string; data: CalendarVisit }
    | { kind: "exception"; at: string; data: CalendarException }
    | { kind: "free"; at: string; data: FreeSlot };

  const dayItems: DayItem[] = [
    ...bookings.map((data) => ({ kind: "booking" as const, at: data.localStart, data })),
    ...visits.map((data) => ({ kind: "visit" as const, at: data.localStart, data })),
    ...exceptions.map((data) => ({ kind: "exception" as const, at: data.localStart, data })),
    ...freeSlots.map((data) => ({ kind: "free" as const, at: formatLocalTime(data.start), data })),
  ].sort(
    (left, right) =>
      left.at.localeCompare(right.at) || Number(left.kind === "free") - Number(right.kind === "free"),
  );

  /*
   * One run per master in a studio; the whole day, unheaded, everywhere else.
   *
   * Each run keyed by whose it is, the unheaded one included: narrowing «all
   * masters» to one of them — which is what opening a request from the bell
   * does — then keeps that master's list, and the card already open in it,
   * instead of drawing a new one with every card shut.
   */
  const dayGroups: { key: string; specialistId: string | null; items: DayItem[] }[] = byMaster
    ? groupDayByMaster(
        dayItems,
        (item) => item.data.specialistId,
        specialists.map((person) => person.id),
      ).map((group) => ({ key: group.specialistId, ...group }))
    : dayItems.length > 0
      ? [{ key: ownSpecialistId ?? (filters.specialist || specialists[0]?.id) ?? "day", specialistId: null, items: dayItems }]
      : [];

  /**
   * The heading's name: the roster's, or for somebody no longer on it the name
   * their own entries carry. An opening is only ever offered for somebody on
   * the roster, so one of the two always answers.
   */
  const masterNameOf = (specialistId: string, items: readonly DayItem[]) =>
    specialists.find((person) => person.id === specialistId)?.name ??
    items.flatMap((item) => (item.kind === "free" ? [] : [item.data.specialistName]))[0] ??
    "";

  /*
   * The month and its year, in one list.
   *
   * The year used to be a control of its own, and a year is not a thing the
   * calendar needs a place for: it is a part of the month's name. One list has
   * to stop somewhere, though, and wherever it stops is a month nobody can
   * reach — so it does not stop at a fixed place. It is built around the month
   * on screen, two years back to one forward (a studio reads back over its own
   * records and books forward only as far as `max_advance_days` allows), and it
   * is built again from wherever the choice lands. Any month is reachable; it is
   * only that the far ones take two choices instead of one.
   *
   * Read from `selected`, not from the clock: this renders on the server and
   * hydrates in the browser, and `new Date()` on both sides of that is two
   * readings — on New Year's Eve, of two different years. A link kept from
   * further back still shows the month it is actually on, because the list is
   * centred on it.
   */
  const anchor = parseLocalDate(selected) ?? { year: 1970, month: 1, day: 1 };

  /*
   * The fifteenth at midday, not the first at midnight. `toLocaleDateString`
   * reads an instant in the browser's own zone, and a first-of-the-month
   * instant is within a few hours of the month before — far enough west and
   * every name in this list would be off by one.
   */
  const monthName = (year: number, month: number) =>
    new Date(Date.UTC(year, month - 1, 15, 12)).toLocaleDateString(localeTag, { month: "long" });

  const monthOptions = Array.from({ length: MONTHS_BACK + 1 + MONTHS_FORWARD }, (_, position) => {
    const counted = anchor.year * 12 + (anchor.month - 1) + (position - MONTHS_BACK);
    const year = Math.floor(counted / 12);
    const month = (counted % 12) + 1;
    return {
      value: `${year}-${String(month).padStart(2, "0")}`,
      year,
      month,
      label: `${monthName(year, month)} ${year}`,
    };
  });

  /**
   * The listed day, spelled out — the name of the panel below the grid rather
   * than a heading printed inside it. The grid says which date is chosen by
   * filling it in, and a heading repeating that was the same fact twice.
   */
  const dayLabel = formatLongDate(new Date(`${selected}T12:00:00`), localeTag);

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

  /*
   * One refusal, drawn where the desk is looking: under the toolbar, or inside
   * the appointment window while it is open — behind its backdrop a banner
   * would be an error nobody can see.
   */
  const errorBanner = error && (
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
  );

  /*
   * The appointment form, in the page's own flow: first in the board, under the
   * top bar, as tall as its form and with nothing in it that scrolls. It is the
   * page that scrolls, so the whole form is always reachable — the end of it is
   * the end of the page, with the room the bottom bar needs already kept there.
   * (As a box of its own between the bars it ran out of scroll before it ran out
   * of form.) A fixed layer under it dims the rest of the page and stops it being
   * pressed; the bars stay above that layer, as they are above any content.
   *
   * Not closed by tapping outside, unlike the question windows: this one holds a
   * form with a client half typed into it, and a stray tap outside it must not
   * throw that away. Esc and «Отмена» close it.
   */
  const composeDialog = composeOpen && canWrite && bookable.length > 0 && locations.length > 0 && services.length > 0 && (
    <>
      <div className="calendar-compose-dim" aria-hidden="true" />
          <div className="calendar-compose-scroll">
            <div
              className="modal-card calendar-compose-dialog"
              id="new-booking"
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-booking-title"
              tabIndex={-1}
              ref={composeCard}
            >
              <button
              className="calendar-compose-close"
              type="button"
              aria-label={t("calendar.closeForm")}
              title={t("calendar.closeForm")}
              onClick={closeCompose}
              disabled={pending}
            >
              <ToolIcon name="close" />
            </button>
            <h2 id="new-booking-title">{t("calendar.newBooking")}</h2>
              {errorBanner}
              <form className="inline-form" onSubmit={createBooking}>
                {/*
                  The address and the master are asked for only where there is
                  a choice; with one of each the two selects were four taps of
                  ceremony in front of every appointment a studio of one wrote
                  by hand. Hidden rather than dropped, because the endpoint
                  still needs both and this form is read from `FormData`.
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
                {chosenSpecialist === null ? (
                  // Nobody chosen yet: the one question, and nothing under it that
                  // depends on the answer — whose services, whose free times.
                  <>
                    <MasterPicker
                      legend={t("calendar.whoToBook")}
                      name="specialist_choice"
                      people={bookable.map((person) => ({
                        id: person.id,
                        name: person.name,
                        avatar: person.avatar ?? null,
                      }))}
                      value=""
                      onChange={setComposeSpecialist}
                    />
                    <div className="button-row">
                      <button className="secondary-button" type="button" onClick={closeCompose} disabled={pending}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <input type="hidden" name="specialist_id" value={chosenSpecialist.id} />
                    {/*
                      Who this is for, by their face and name. The face is not
                      pressed; the one button beside the name takes the form back
                      to the question. Only where there was a choice: a studio of
                      one has no one else to name.
                    */}
                    {bookable.length > 1 && (
                      <div className="calendar-compose-master">
                        <span className="avatar" aria-hidden="true">
                          {chosenSpecialist.avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a studio's own photo, not a build-time asset.
                            <img src={chosenSpecialist.avatar} alt="" />
                          ) : (
                            chosenSpecialist.name.trim().slice(0, 1).toUpperCase() || "?"
                          )}
                        </span>
                        <p>
                          {t("calendar.specialist")}: <strong>{chosenSpecialist.name}</strong>
                        </p>
                        <button type="button" className="calendar-compose-change" onClick={() => setComposeSpecialist("")}>
                          {t("calendar.clientChange")}
                        </button>
                      </div>
                    )}
                <ServiceRows
                  lines={composeLinesNow}
                  services={offeredServices}
                  addOns={addOns}
                  addOnsLegend={t("calendar.addOns")}
                  locale={locale}
                  formatPrice={money}
                  onChange={setComposeLines}
                />
                {/*
                  The next two weeks as buttons, as on the public page, because
                  most appointments are written for «сегодня» or «на этой
                  неделе» and a date field is a calendar to open for that. «Ещё»
                  at the end is the date field itself, for any other day, and is
                  what the form reads.
                */}
                <DayStrip
                  days={stripDates(today, composeDate).map((date) => {
                    const stamp = new Date(`${date}T12:00:00Z`);
                    const weekday = new Intl.DateTimeFormat(localeTag, { timeZone: "UTC", weekday: "short" }).format(stamp);
                    const day = new Intl.DateTimeFormat(localeTag, { timeZone: "UTC", day: "numeric", month: "short" }).format(stamp);
                    return {
                      date,
                      top: date === today ? t("calendar.today") : date === addDaysTo(today, 1) ? t("calendar.tomorrow") : weekday,
                      main: day,
                      label: `${weekday}, ${day}`,
                    };
                  })}
                  selected={composeDate}
                  onPick={setComposeDate}
                  trailing={
                    <DayMoreTile
                      label={t("calendar.moreDates")}
                      fieldLabel={t("calendar.otherDate")}
                      value={composeDate}
                      today={today}
                      localeTag={localeTag}
                      labels={{
                        title: t("calendar.pickDate"),
                        today: t("calendar.today"),
                        close: t("calendar.closeForm"),
                        previous: t("calendar.previousMonth"),
                        next: t("calendar.nextMonth"),
                      }}
                      onChange={setComposeDate}
                    />
                  }
                />
                {/*
                  The free times of that date for that master and that sitting.
                  Tapping one sets the time the form reads from the hidden field
                  above; «Другое» on its heading is the way to a time the grid
                  does not offer, because the desk may book one.
                */}
                {composeLinesNow.length === 0 && <p className="compose-hint">{t("calendar.pickServiceFirst")}</p>}
                <BookingSlotPicker
                  url={slotsUrl({
                    locationId: composeLocation,
                    specialistId: composeSpecialistId,
                    date: composeDate,
                    lines: composeLinesNow,
                  })}
                  value={composeTime}
                  onPick={setComposeTime}
                  locale={locale}
                  trailing={
                    <TimeMoreTile
                      label={t("calendar.otherTime")}
                      fieldLabel={t("calendar.time")}
                      value={composeTime}
                      onChange={setComposeTime}
                    />
                  }
                />
                <input type="hidden" name="time" value={composeTime} />
                <ClientPicker clients={clients} locale={locale} />
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={closeCompose} disabled={pending}>
                    {t("common.cancel")}
                  </button>
                  <button className="primary-button" type="submit" disabled={pending}>
                    {pending ? t("common.saving") : t("calendar.book")}
                  </button>
                </div>
                </>
                )}
              </form>
            </div>
          </div>
    </>
  );

  return (
    <>
      {composeDialog}
      <nav className="calendar-toolbar" aria-label={t("calendar.period")}>
        <div className="calendar-where calendar-where-board">
          {/*
            The month, with its year, which is what the grid below is drawing. A
            date was only ever needed here while the board was one day wide; the
            day the list is showing is named over the list itself, where the
            reader is when they need it.
          */}
          <span className="calendar-period">
            <select
              aria-label={t("calendar.month")}
              value={`${anchor.year}-${String(anchor.month).padStart(2, "0")}`}
              onChange={(event) => {
                const [year, month] = event.target.value.split("-").map(Number);
                router.push(queryFor({ ...filters, date: dateIn(selected, { year, month }) }));
              }}
            >
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
          {/*
            The way back, and the one control of the old set that was not a
            second way to do something.

            The arrows went because the month select already steps a month, and
            they stepped exactly one. This does something neither the grid nor
            the select can: today's date wears a ring in the grid and can be
            pressed — but only while today is in the month on screen. From March
            2027 the way home is a change of the month, a trip to the server of
            its own, and this is one.
          */}
          <Link className="secondary-button" href={queryFor({ ...filters, date: today })}>
            {t("calendar.today")}
          </Link>

          {/*
            Whose calendar this is: the studio's own face first, then each master,
            as buttons rather than a list to open — on the bar's second row, big,
            under the month and «Сегодня», because they are what the desk presses
            most and a face is not something to find at 40 units.

            It is the filter a studio reaches for many times a day — «покажи день
            Ирины» — and a select cost two taps every time and, on a phone, a
            sheet that opened off the side of the screen. A row of faces is one
            tap and shows the choices before it is made. First is the studio
            itself, «все мастера»; pressing the master who is already chosen
            takes the filter off again.

            Links, not buttons: choosing is going to a page the server reads, the
            same mechanism the grid's own dates and «Сегодня» use through
            `queryFor`, so the address keeps the filter and a face can be opened
            in another tab. `aria-current` says which is on — and the ring, and
            the name written under the row, say it too, because a face at 40
            units is not something to tell two masters apart by, nor colour
            something to carry a state alone.
          */}
          {canFilterBySpecialist && specialists.length > 1 && (
            <div className="calendar-masters">
              <div className="calendar-masters-row" role="group" aria-label={t("calendar.specialist")}>
                <Link
                  className="calendar-pick"
                  href={queryFor({ ...filters, specialist: "", date: selected })}
                  aria-current={filters.specialist === "" ? "true" : undefined}
                  aria-label={t("calendar.allSpecialists")}
                  title={t("calendar.allSpecialists")}
                >
                  <span className="avatar avatar-studio" aria-hidden="true">
                    {studio.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- the studio's own logo, not a build-time asset.
                      <img src={studio.logo} alt="" />
                    ) : (
                      studio.name.trim().slice(0, 1).toUpperCase() || "?"
                    )}
                  </span>
                </Link>
                {specialists.map((person) => {
                  const chosen = filters.specialist === person.id;
                  return (
                    <Link
                      key={person.id}
                      className="calendar-pick"
                      href={queryFor({ ...filters, specialist: chosen ? "" : person.id, date: selected })}
                      aria-current={chosen ? "true" : undefined}
                      aria-label={person.name}
                      title={person.name}
                    >
                      <span className="avatar" aria-hidden="true">
                        {person.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a studio's own photo, not a build-time asset.
                          <img src={person.avatar} alt="" />
                        ) : (
                          person.name.trim().slice(0, 1).toUpperCase() || "?"
                        )}
                      </span>
                    </Link>
                  );
                })}
              </div>
              <p className="calendar-masters-caption" aria-live="polite">
                {specialists.find((person) => person.id === filters.specialist)?.name ??
                  t("calendar.allSpecialists")}
              </p>
            </div>
          )}

        </div>
      </nav>

      {/* While the appointment window is open it shows the refusal itself. */}
      {!composeOpen && errorBanner}
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
      <section className="panel calendar-month" aria-label={`${monthName(anchor.year, anchor.month)} ${anchor.year}`}>
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

        {/*
          Said even when the openings follow: a day drawn in dashes alone does
          not say that nobody is booked, and that is what the reader came to
          find out.
        */}
        {dayItems.every((item) => item.kind === "free") && <p className="muted">{t("calendar.emptyDay")}</p>}
        {dayGroups.map((group) => (
          <div key={group.key} className="calendar-group">
            {group.specialistId !== null && (
              <h3 className="calendar-group-head calendar-master">
                {faceOf(group.specialistId)}
                {masterNameOf(group.specialistId, group.items)}
              </h3>
            )}
            <ul className="calendar-list">
              {group.items.map((item) => {
                  if (item.kind === "free") {
                    const slot = item.data;
                    const from = formatLocalTime(slot.start);
                    const to = formatLocalTime(slot.end);
                    return (
                      <li key={`free-${slot.specialistId}-${slot.locationId}-${slot.start}`} className="calendar-free">
                        {/*
                          A button, not a card that opens: there is nothing inside
                          an opening to read, only a window to open on it. The label
                          says what pressing does, because «10:00–12:00 Свободно»
                          alone is a statement and this is a control.
                        */}
                        <button
                          type="button"
                          className="calendar-free-slot"
                          aria-label={t("calendar.freeSlotBook", { from, to })}
                          onClick={() =>
                            openCompose({ locationId: slot.locationId, specialistId: slot.specialistId, time: from })
                          }
                        >
                          <span className="calendar-time">
                            {from}–{to}
                          </span>
                          <span className="calendar-what">{t("calendar.freeSlot")}</span>
                          {/* The address, where there is more than one: the same hours at two of them are two openings. */}
                          {locations.length > 1 && (
                            <span className="unit-hint">
                              {locations.find((place) => place.id === slot.locationId)?.name}
                            </span>
                          )}
                          <span className="calendar-free-plus" aria-hidden="true">
                            <ToolIcon name="plus" />
                          </span>
                        </button>
                      </li>
                    );
                  }
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
                    if (item.kind === "visit") {
                      const visit = item.data;
                      return (
                        <li key={visit.id} id={`visit-${visit.id}`} className="calendar-entry is-visit">
                          <details>
                            <summary>
                              <span className="calendar-time">
                                {visit.localStart}–{visit.localEnd}
                              </span>
                              <span className="calendar-what">
                                {visit.serviceName}
                                {visit.extraLines > 0 && <span className="unit-hint">+{visit.extraLines}</span>}
                              </span>
                              <span className="calendar-who">
                                {visit.clientName ?? t("calendar.noClient")}
                              </span>
                              {/* Grey says it is done; the words say it to a reader who cannot see grey. */}
                              <span className="sr-only">{t("calendar.visitClosed")}</span>
                            </summary>
                            <div className="calendar-detail">
                              <p className="muted">
                                {visit.specialistName}
                                {visit.revenueMinor !== null && <> · {money(visit.revenueMinor)}</>}
                              </p>
                              <p>
                                <Link className="text-link" href={`/app/visits?visit=${visit.id}`}>
                                  {t("calendar.openVisit")}
                                </Link>
                              </p>
                            </div>
                          </details>
                        </li>
                      );
                    }
                    const booking = item.data;
                    return (
                    <li
                      key={booking.id}
                      id={`booking-${booking.id}`}
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
                          </span>
                          {/*
                            Never colour alone (section 7.8): the status is words.
                            On a phone the two live statuses become a tick and an
                            exclamation mark; the words stay in the DOM, hidden
                            visually, so the mark is still read out.
                          */}
                          <span
                            className={`calendar-status${
                              booking.status === "confirmed" || booking.status === "pending_confirmation"
                                ? ` has-icon status-${booking.status}`
                                : ""
                            }`}
                          >
                            {(booking.status === "confirmed" || booking.status === "pending_confirmation") && (
                              <StatusIcon name={booking.status === "confirmed" ? "confirmed" : "pending"} />
                            )}
                            <span className="calendar-status-word">
                              {t(`bookingStatus.${booking.status}` as MessageKey)}
                            </span>
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
                          {booking.clientNotes && (
                            <div className="calendar-client-notes">
                              <strong>{t("calendar.clientNotes")}</strong>
                              <p className="client-notes-text">{booking.clientNotes}</p>
                            </div>
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
                                <ClientContact
                                  phone={booking.clientPhone}
                                  locale={locale}
                                  marks={booking.clientChannels}
                                />
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

                          {/*
                            Asked the moment the visit is closed, on the card that
                            has just turned grey: the client is still at the desk,
                            and the next visit is one question away.
                          */}
                          {canWrite && booking.status === "completed" && booking.clientId && (
                            <NextVisit bookingId={booking.id} locale={locale} localeTag={localeTag} />
                          )}

                          {/*
                            A cancelled hour still to come is a gap somebody can fill:
                            offered here to the clients who are due back, as a message
                            the studio edits and sends itself.
                          */}
                          {canWrite && booking.status === "cancelled" && booking.localDate >= today && (
                            <SlotFillPanel
                              bookingId={booking.id}
                              locale={locale}
                              localeTag={localeTag}
                              autoOpen={justCancelled === booking.id}
                            />
                          )}

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
                                    <summary>{t("calendar.modifyClose")}</summary>
                                    <form className="inline-form" onSubmit={(e) => complete(booking, e)}>
                                      <PaidField
                                        id={`paid-${booking.id}`}
                                        value={paidInputs[booking.id] ?? toMajorUnits(booking.priceMinor)}
                                        priceMinor={booking.priceMinor}
                                        paidMinor={
                                          paidInputs[booking.id] === undefined
                                            ? null
                                            : toMinorUnits(paidInputs[booking.id])
                                        }
                                        currency={currency}
                                        locale={locale}
                                        onChange={(value) =>
                                          setPaidInputs((previous) => ({ ...previous, [booking.id]: value }))
                                        }
                                      />
                                      <TipField
                                        id={`tip-${booking.id}`}
                                        value={tipInputs[booking.id] ?? ""}
                                        currency={currency}
                                        locale={locale}
                                        onChange={(value) =>
                                          setTipInputs((previous) => ({ ...previous, [booking.id]: value }))
                                        }
                                      />
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
                                      <button
                                        className="primary-button"
                                        type="submit"
                                        disabled={
                                          pending ||
                                          (paidInputs[booking.id] !== undefined &&
                                            toMinorUnits(paidInputs[booking.id]) === null) ||
                                          tipMinorOf(tipInputs[booking.id] ?? "") === null
                                        }
                                      >
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
                                      {specialistOptions(reassignable, {
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
          </div>
        ))}
      </section>

      {canWrite && bookable.length > 0 && locations.length > 0 && services.length > 0 && (
        <button
          className="calendar-fab"
          type="button"
          aria-label={t("quick.booking")}
          title={t("quick.booking")}
          onClick={() => openCompose()}
        >
          <ToolIcon name="plus" />
        </button>
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
/** The window of days the form's strip shows: two weeks, as the public page does. */
const STRIP_DAYS = 14;

/**
 * The days the strip offers: from today, or from the chosen day when that lies
 * beyond the first two weeks, so the day picked on the date field is always on
 * screen and lit. A day in the past is never offered; the date field still
 * takes one, because the desk writes up yesterday's work too.
 */
function stripDates(today: string, chosen: string): string[] {
  const first = chosen > today && chosen >= addDaysTo(today, STRIP_DAYS) ? chosen : today;
  return Array.from({ length: STRIP_DAYS }, (_, offset) => addDaysTo(first, offset));
}

function addDaysTo(date: string, days: number): string {
  const parsed = parseLocalDate(date);
  if (!parsed) return date;
  const moved = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return formatLocalDate({
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  });
}

function dateIn(date: string, part: Readonly<{ year?: number; month?: number }>) {
  const parsed = parseLocalDate(date);
  if (!parsed) return date;

  const year = part.year ?? parsed.year;
  const month = part.month ?? parsed.month;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return formatLocalDate({ year, month, day: Math.min(parsed.day, lastDay) });
}
