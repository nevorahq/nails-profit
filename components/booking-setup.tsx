"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  SetupGuideDialog,
  useSetupGuide,
  type SetupGuideBaseline,
} from "@/components/setup-guide";
import { SLUG_MIN_LENGTH, slugify } from "@/domain/slug";
import { formatLocalTime, parseLocalTime, weekdays, type Weekday } from "@/domain/timezone";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import type { MemberRole } from "@/domain/rbac";

export type LocationRow = {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  timezone: string;
  status: "active" | "archived";
  public_status: "draft" | "published" | "paused" | null;
  slot_step_minutes: number | null;
  min_lead_minutes: number | null;
  max_advance_days: number | null;
  buffer_before_minutes: number | null;
  buffer_after_minutes: number | null;
  confirmation_mode: "instant" | "manual" | null;
  confirmation_ttl_minutes: number | null;
  verification_mode: "off" | "code" | null;
  verification_ttl_minutes: number | null;
  reminder_lead_minutes: number | null;
  /**
   * Whether a client has ever been booked here. The address is then a record of
   * where money was earned, and the endpoint refuses to delete it — so the
   * screen stops offering the control rather than letting it fail.
   */
  has_bookings?: boolean;
};

export type RotaRule = {
  specialist_id: string;
  location_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  effective_from: string;
};

/**
 * Why this address cannot be deleted, or null when it can.
 *
 * Two refusals, and the endpoint states both again — a screen deciding what to
 * offer is not access control. The order is the order they stop mattering in:
 * a booked address is never deletable, a published one becomes deletable the
 * moment its page comes down.
 */
function deleteBlockerOf(place: LocationRow): MessageKey | null {
  if (place.has_bookings) return "bookingSetup.deleteHasBookings";
  if (place.public_status === "published") return "bookingSetup.deleteWhilePublished";
  return null;
}

const WEEKDAY_KEYS: Record<Weekday, MessageKey> = {
  1: "weekday.monday",
  2: "weekday.tuesday",
  3: "weekday.wednesday",
  4: "weekday.thursday",
  5: "weekday.friday",
  6: "weekday.saturday",
  7: "weekday.sunday",
};

const SLOT_STEPS = [5, 10, 15, 20, 30, 60] as const;

/**
 * The zones a browser knows, which is every IANA name the location endpoint
 * will accept. Listing them beats a free-text field: a timezone typed as
 * "Chisinau" is refused by the API, and one typed as "Europe/Kiev" is accepted
 * and quietly wrong by an hour twice a year.
 */
/**
 * The week the guided setup offers with one press, and the one the rota form
 * arrives pre-filled with.
 *
 * Five days rather than seven and 08:00–18:00 rather than anything cleverer:
 * the point is not to guess a studio's hours but to spare the first-time owner
 * fourteen inputs before they have seen a single slot. Offered, never saved
 * behind their back — these are the hours break-even is computed from and the
 * hours clients are shown free slots in. Every day of it is editable in the
 * rota below, and a rota that already exists is always answered with itself.
 */
const DEFAULT_WORKWEEK = { weekdays: [1, 2, 3, 4, 5] as const, start: "08:00", end: "18:00" };

/** The order of the first address's steps, and the order they are drawn in. */
const SETUP_STEPS = ["location", "rota", "publish"] as const;

/**
 * The zone the owner is sitting in, which for a studio setting up its own
 * address is the zone that address is in. Falls back to the one this product
 * was built for rather than to UTC — a Moldovan salon offered "UTC" reads it as
 * a bug, and an hour of wrong slots is worse than a list nobody opened.
 */
function localTimezone(supported: string[]): string {
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (guess && supported.includes(guess)) return guess;
  return supported.includes("Europe/Chisinau") ? "Europe/Chisinau" : (supported[0] ?? "UTC");
}

function knownTimezones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const all = supported ? supported("timeZone") : [];
  return all.length > 0 ? all : ["Europe/Chisinau", "Europe/Bucharest", "UTC"];
}

/** `HH:MM` for an input, from the minutes the API speaks. */
function timeValue(minute: number) {
  return formatLocalTime(minute);
}

function describeStatus(location: LocationRow, t: Translate) {
  if (location.status === "archived") return t("bookingSetup.stateArchived");
  if (location.public_status === "published") return t("bookingSetup.statePublished");
  if (location.public_status === "paused") return t("bookingSetup.statePaused");
  return t("bookingSetup.stateDraft");
}

export function BookingSetup({
  monthGuide = null,
  organizationName,
  locations,
  specialists,
  assignments,
  rota,
  bookingAccess,
  organizationSlug,
  canManage,
  canPublish,
  canSaveRota,
  slotsChecked = false,
  nearestSlotDate = null,
  role,
  ownSpecialistId,
  locale,
}: {
  /**
   * Where «Расчёт месяца» stood when this page was drawn, or null when there is
   * nothing to guide: no closed visit yet, both steps already done, or a role
   * that cannot see the other half of the list.
   */
  monthGuide?: SetupGuideBaseline;
  /**
   * The studio's own name, offered as the first address's name.
   *
   * For a solo master the two are the same word, and for a studio with one
   * salon they are as well — the second address is where they start to differ,
   * and by then this field is being filled in deliberately. So the first one
   * arrives already answered rather than asking somebody to retype what they
   * typed when they created the workspace.
   */
  organizationName: string;
  locations: LocationRow[];
  specialists: { id: string; name: string }[];
  assignments: { specialist_id: string; location_id: string }[];
  rota: RotaRule[];
  bookingAccess: "off" | "calendar" | "public";
  /** The organization's own slug: the public page lives at `/book/<slug>`. */
  organizationSlug: string | null;
  canManage: boolean;
  canPublish: boolean;
  canSaveRota?: boolean;
  /**
   * Whether the availability engine was asked at all. False before there is a
   * published address and a rota to ask about — the blockers already say what
   * is missing then, and the answer would only repeat them.
   */
  slotsChecked?: boolean;
  /**
   * The first day in the next fortnight a client could book, `null` when there
   * is none. A date rather than a flag: "ближайшее — понедельник" is the answer
   * the owner is actually after, and an empty two weeks is the same answer with
   * nothing in it.
   */
  nearestSlotDate?: string | null;
  role?: MemberRole;
  ownSpecialistId?: string | null;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const guide = useSetupGuide(monthGuide, "/api/v1/onboarding/month");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isMaster = role === "master";

  /*
   * Which row each picker is pointing at.
   *
   * Stored as "what the user chose", never as "what to show": a `useState`
   * initializer runs once, and every one of these lists arrives from the server
   * and grows while the page is open. Saving a form here calls
   * `router.refresh()`, which re-renders with new props and deliberately keeps
   * client state — so a choice seeded from an empty list stayed empty forever.
   *
   * The visible effect was the worst kind: adding the studio's first address
   * left «Параметры записи» hidden, because the id in state matched nothing,
   * and the checklist above went on asking for the address to be published with
   * no control on screen to publish it. A reload fixed it, which is exactly the
   * kind of thing nobody thinks to try.
   */
  const [settingsFor, setSettingsFor] = useState("");
  const [rotaSpecialist, setRotaSpecialist] = useState("");
  const [rotaLocation, setRotaLocation] = useState("");

  /** Which address is one click from being removed. Null while nothing is. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** Whether the owner asked for every panel while the guided setup is showing. */
  const [manualSetup, setManualSetup] = useState(false);
  /** Whose week the guided step writes. Empty means the only master there is. */
  const [setupSpecialist, setSetupSpecialist] = useState("");
  const publicPageHref = organizationSlug === null ? null : `/book/${organizationSlug}`;

  const timezones = useMemo(() => knownTimezones(), []);

  /** The chosen row while it still exists, otherwise the sensible default. */
  const settingsLocation =
    locations.find((place) => place.id === settingsFor) ?? locations[0] ?? null;

  const currentSpecialistId =
    specialists.find((person) => person.id === rotaSpecialist)?.id ??
    ownSpecialistId ??
    specialists[0]?.id ??
    "";

  // A master's own assignment wins over the first address in the list: the rota
  // they came to edit is the one at the place they actually work.
  const currentLocationId =
    locations.find((place) => place.id === rotaLocation)?.id ??
    (ownSpecialistId
      ? assignments.find((row) => row.specialist_id === ownSpecialistId)?.location_id
      : undefined) ??
    locations[0]?.id ??
    "";

  /**
   * The address that is actually working, and the one fact this page asks
   * before it decides how to look: published, somebody assigned to it, and
   * hours for that somebody. A studio with none of those is setting up for the
   * first time and gets walked through it; a studio with one is running, and
   * gets the panels it already knows.
   */
  const workingPlace = locations.find(
    (place) =>
      place.status === "active" &&
      place.public_status === "published" &&
      assignments.some((row) => row.location_id === place.id) &&
      rota.some((rule) => rule.location_id === place.id),
  );

  const firstPlace = locations.find((place) => place.status === "active");

  /*
   * The three steps of a first address, in the order the work is actually done.
   *
   * Assignment is not one of them: choosing whose hours to write at an address
   * is what puts them there, and asking twice for one fact is how a checklist
   * grows the step nobody understands. The parameters are not steps either —
   * slot length, buffers, lead time, confirmation all have defaults that work,
   * and somebody who has not yet seen a booking has no opinion about a cleaning
   * buffer.
   */
  const setupStep: (typeof SETUP_STEPS)[number] | null =
    !canPublish || workingPlace
      ? null
      : !firstPlace
        ? "location"
        : !(
              assignments.some((row) => row.location_id === firstPlace.id) &&
              rota.some((rule) => rule.location_id === firstPlace.id)
            )
          ? "rota"
          : "publish";

  /**
   * What is still missing before a client could book anything. Every studio
   * hits this list in the same order, and finding out which step was skipped
   * from an empty public page is the part that wastes an afternoon.
   */
  /*
   * Two things that are not blockers, and are not each other.
   *
   * The operator's switch was in the list above, between steps the owner
   * finishes themselves — so it read as one more chore, and there is no click
   * on this screen that closes it. It is stated on its own now, as somebody
   * else's step.
   *
   * An empty fortnight is the opposite kind of line: everything is set up, and
   * the page is still a dead end for a client. It replaces "всё готово" rather
   * than sitting under it, because both cannot be true at once.
   */
  const active = locations.filter((place) => place.status === "active");
  const published = active.filter((place) => place.public_status === "published");
  const assignedLocationIds = new Set(assignments.map((row) => row.location_id));
  const rotaKeys = new Set(rota.map((rule) => `${rule.specialist_id}:${rule.location_id}`));
  const blockers: MessageKey[] = [
    active.length === 0 ? "bookingSetup.blockerLocation" : null,
    active.length > 0 && published.length === 0 ? "bookingSetup.blockerPublish" : null,
    specialists.length === 0 ? "bookingSetup.blockerSpecialist" : null,
    specialists.length > 0 && published.some((place) => !assignedLocationIds.has(place.id))
      ? "bookingSetup.blockerAssign"
      : null,
    published.length > 0 &&
    !published.some((place) =>
      specialists.some((person) => rotaKeys.has(`${person.id}:${place.id}`)),
    )
      ? "bookingSetup.blockerRota"
      : null,
  ].filter((key): key is MessageKey => key !== null);

  /**
   * @param translated Refusals this caller has a written answer for, by API
   *   code. Without one the envelope's `message` is shown, and that field is a
   *   developer-facing English sentence — fine for a validation slip nobody
   *   should reach, wrong for a refusal that is a normal outcome and needs to
   *   say what to do instead.
   */
  async function send(
    url: string,
    method: string,
    payload: unknown,
    form?: HTMLFormElement,
    translated: Partial<Record<string, MessageKey>> = {},
  ) {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const key = translated[body?.error?.code as string];
      setError(key ? t(key) : (body?.error?.message ?? t("common.saveFailed")));
      setPending(false);
      return false;
    }
    form?.reset();
    setPending(false);
    router.refresh();
    return true;
  }

  async function createLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await send(
      "/api/v1/locations",
      "POST",
      {
        name: String(data.get("name") ?? "").trim(),
        slug: String(data.get("slug") ?? "").trim(),
        address: String(data.get("address") ?? "").trim() || undefined,
        timezone: String(data.get("timezone") ?? ""),
      },
      form,
    );
  }

  /**
   * The first address, from the two facts a person can answer without thinking.
   *
   * The slug is derived from the name and the timezone from the browser: both
   * are required by the endpoint, neither is a decision the owner has an
   * opinion about on their first minute, and both stay editable in the address
   * row afterwards. `slugify` is the same function the studio's own public
   * address is suggested with, so a Cyrillic name produces a link that works.
   */
  async function createFirstLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const suggested = slugify(name);
    await send(
      "/api/v1/locations",
      "POST",
      {
        name,
        // Short names transliterate to something the endpoint refuses; the
        // address still needs one, and a studio never sees this field again.
        slug: suggested.length >= SLUG_MIN_LENGTH ? suggested : `${suggested}-1`,
        address: String(data.get("address") ?? "").trim() || undefined,
        timezone: localTimezone(timezones),
      },
      form,
    );
  }

  /**
   * Whose hours these are, and the week they work — one submit for both.
   *
   * The assignment goes first and the rota second because the rota endpoint
   * refuses a specialist who does not work at the address. Two requests, one
   * button: they are one decision, and the screen that made them two is the one
   * being replaced.
   */
  async function scheduleFirstWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firstPlace) return;
    const specialistId = setupSpecialist || specialists[0]?.id;
    if (!specialistId) return;

    const assigned = await send(`/api/v1/specialists/${specialistId}/locations`, "PUT", {
      location_ids: [
        ...new Set([
          ...assignments.filter((row) => row.specialist_id === specialistId).map((row) => row.location_id),
          firstPlace.id,
        ]),
      ],
    });
    if (!assigned) return;

    await send("/api/v1/availability/rules", "PUT", {
      specialist_id: specialistId,
      location_id: firstPlace.id,
      effective_from: new Date().toISOString().slice(0, 10),
      intervals: DEFAULT_WORKWEEK.weekdays.map((weekday) => ({
        weekday,
        start: DEFAULT_WORKWEEK.start,
        end: DEFAULT_WORKWEEK.end,
      })),
    });
  }

  /**
   * Opening the studio itself, which is a different switch from publishing an
   * address and used to be reachable from nowhere.
   *
   * Publishing an address raises this too — see the booking-settings endpoint —
   * but only at the moment it is published. A studio whose address was already
   * published before that behaviour existed sat in a dead end: `booking_access`
   * stayed `calendar`, `/book/<slug>` answered 404, and the only screen that
   * could explain it said «ждём оператора» and offered no control at all.
   */
  async function openPublicBooking() {
    const opened = await send("/api/v1/organizations/settings", "PATCH", {
      booking_access: "public",
    });
    // Straight to the thing that was just opened: the owner pressed this to see
    // a page exist, and reading about it on the setup screen is not that.
    if (opened && publicPageHref) router.push(publicPageHref);
  }

  async function updateLocation(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await send(`/api/v1/locations/${id}`, "PATCH", {
      name: String(data.get("name") ?? "").trim(),
      address: String(data.get("address") ?? "").trim() || null,
      timezone: String(data.get("timezone") ?? ""),
      status: String(data.get("status") ?? "active"),
    });
  }

  /**
   * Publishing from the address row itself.
   *
   * The same endpoint the settings panel calls, and the same one field. It is
   * here because the checklist above says «Опубликуйте адрес» and the only
   * control that could was three panels down, behind a second address picker,
   * among ten fields about lead times and buffers — a step the product asks for
   * and then hides.
   *
   * Coming back off the page is `paused`, not `draft`: the address was public
   * once, and a studio that closes for August is pausing rather than saying it
   * had never been published. `draft` stays reachable in the settings panel,
   * which is where a state nobody needs day to day belongs.
   */
  async function setPublicStatus(id: string, status: "published" | "paused") {
    await send(`/api/v1/locations/${id}/booking-settings`, "PUT", { public_status: status });
  }

  async function deleteLocation(id: string) {
    const removed = await send(`/api/v1/locations/${id}`, "DELETE", undefined, undefined, {
      LOCATION_HAS_BOOKINGS: "bookingSetup.deleteHasBookings",
      LOCATION_PUBLISHED: "bookingSetup.deleteWhilePublished",
    });
    setConfirmDelete(null);
    // The address that was showing settings may be the one just removed; the
    // picker falls back to the first remaining one on its own.
    if (removed && settingsFor === id) setSettingsFor("");
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const number = (field: string) => Number(String(data.get(field) ?? ""));
    /*
     * Deliberately without `public_status`. Whether the page is public is set
     * on the address row now, and every field in this form is uncontrolled with
     * a `defaultValue` — a value React does not re-apply while the form keeps
     * its key. Publishing from the row and then saving a buffer here would have
     * posted the status this form was rendered with, silently taking the page
     * down. The endpoint leaves an omitted field alone.
     */
    await send(`/api/v1/locations/${id}/booking-settings`, "PUT", {
      slot_step_minutes: number("slot_step_minutes"),
      min_lead_minutes: number("min_lead_minutes"),
      max_advance_days: number("max_advance_days"),
      buffer_before_minutes: number("buffer_before_minutes"),
      buffer_after_minutes: number("buffer_after_minutes"),
      confirmation_mode: String(data.get("confirmation_mode") ?? "instant"),
      confirmation_ttl_minutes: number("confirmation_ttl_minutes"),
      verification_mode: String(data.get("verification_mode") ?? "off"),
      verification_ttl_minutes: number("verification_ttl_minutes"),
      reminder_lead_minutes: number("reminder_lead_minutes"),
    });
  }

  async function saveAssignment(event: FormEvent<HTMLFormElement>, specialistId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await send(`/api/v1/specialists/${specialistId}/locations`, "PUT", {
      location_ids: data.getAll("location_ids").map(String),
    });
  }

  async function saveRota(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    const intervals: { weekday: number; start: string; end: string }[] = [];
    for (const weekday of weekdays) {
      if (!data.get(`day_${weekday}`)) continue;
      const start = String(data.get(`start_${weekday}`) ?? "");
      const end = String(data.get(`end_${weekday}`) ?? "");
      const from = parseLocalTime(start);
      const to = parseLocalTime(end);
      // The API refuses these too; catching them here means the studio is told
      // which day is wrong instead of being told the request is.
      if (from === null || to === null || to <= from) {
        setError(t("bookingSetup.rotaInvalidDay", { day: t(WEEKDAY_KEYS[weekday]) }));
        return;
      }
      intervals.push({ weekday, start, end });
    }

    const saved = await send("/api/v1/availability/rules", "PUT", {
      specialist_id: currentSpecialistId,
      location_id: currentLocationId,
      effective_from: String(data.get("effective_from") ?? ""),
      intervals,
    });
    /*
     * Hours are what break-even is worked out from, so saving them can finish
     * the month's checklist. Asked of the server rather than assumed here: a
     * rota starting next month, or one saved with every day unticked, moves
     * nothing, and `loadMonthSetup` is the only thing that knows.
     */
    if (saved) await guide.check();
  }

  /*
   * Guided while there is nothing working yet, and never again after that.
   *
   * Not a wizard over the page: the panels stay one link away, because the
   * person changing Tuesday's hours next spring is not the person setting up,
   * and `components/onboarding-panel.tsx` already says why a map beats a
   * corridor — "an owner who already knows the piece they are missing should
   * not be walked through a wizard to reach it".
   */
  const guided = setupStep !== null && !manualSetup;

  const currentRota = rota.filter(
    (rule) => rule.specialist_id === currentSpecialistId && rule.location_id === currentLocationId,
  );
  const rotaFor = (weekday: Weekday) => currentRota.find((rule) => rule.weekday === weekday) ?? null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <SetupGuideDialog
        guide={guide}
        locale={locale}
        strings="monthGuide"
        doneHref="/app/reports/month"
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {guided && (
        <section className="panel booking-panel">
          <h2>{t("bookingSetup.setupTitle")}</h2>
          <p className="muted">{t("bookingSetup.setupHint")}</p>

          {/* Where we are, in the order the work is done: what is behind, what
              is now, and what is left. The current one is the only line that is
              not muted — a list where everything shouts says nothing. */}
          <ol className="compact-list">
            {SETUP_STEPS.map((step, index) => {
              const done = SETUP_STEPS.indexOf(setupStep!) > index;
              return (
                <li key={step} className={step === setupStep ? undefined : "muted"}>
                  <span aria-hidden="true">{done ? "✓" : step === setupStep ? "→" : "○"}</span>{" "}
                  {t(`bookingSetup.setupStep.${step}` as MessageKey)}
                </li>
              );
            })}
          </ol>

          {setupStep === "location" && (
            <form className="inline-form" onSubmit={createFirstLocation}>
              <label>
                {t("bookingSetup.name")}
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  defaultValue={organizationName}
                  placeholder="Studio"
                />
              </label>
              <label>
                {t("bookingSetup.address")}
                <input name="address" maxLength={300} />
              </label>
              {/* The link and the timezone are derived and shown, not asked:
                  both are editable in the address row the moment this is done. */}
              <p className="muted">{t("bookingSetup.setupDerived", { zone: localTimezone(timezones) })}</p>
              <button type="submit" className="primary-button" disabled={pending}>
                {pending ? t("common.saving") : t("bookingSetup.setupNext")}
              </button>
            </form>
          )}

          {setupStep === "rota" && (
            <form className="inline-form" onSubmit={scheduleFirstWeek}>
              {specialists.length === 0 ? (
                <p className="warning-banner">{t("bookingSetup.blockerSpecialist")}</p>
              ) : (
                <>
                  {specialists.length > 1 && (
                    <label>
                      {t("bookingSetup.specialist")}
                      <select
                        value={setupSpecialist || specialists[0].id}
                        onChange={(event) => setSetupSpecialist(event.target.value)}
                      >
                        {specialists.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <p className="muted">
                    {t("bookingSetup.setupWorkweek", {
                      from: DEFAULT_WORKWEEK.start,
                      to: DEFAULT_WORKWEEK.end,
                    })}
                  </p>
                  <button type="submit" className="primary-button" disabled={pending}>
                    {pending ? t("common.saving") : t("bookingSetup.setupWorkweekAction")}
                  </button>
                </>
              )}
            </form>
          )}

          {setupStep === "publish" && firstPlace && (
            <div className="inline-actions">
              <button
                type="button"
                className="primary-button"
                disabled={pending}
                onClick={() => setPublicStatus(firstPlace.id, "published")}
              >
                {pending ? t("common.saving") : t("bookingSetup.publish")}
              </button>
              <span className="muted">{t("bookingSetup.operatorPending")}</span>
            </div>
          )}

          <p className="muted" style={{ marginTop: "16rem" }}>
            <button type="button" className="inline-action" onClick={() => setManualSetup(true)}>
              {t("bookingSetup.setupManual")}
            </button>
          </p>
        </section>
      )}

      {/*
        «Что осталось сделать» is shown while something is. A studio that is
        open, published and taking bookings does not need a panel to tell it so
        every time it opens this screen — the address rows above already carry
        the state, and the link to the live page is right there.
      */}
      {!isMaster && !guided && !(blockers.length === 0 && bookingAccess === "public") && (
        <section className="panel booking-panel">
          <h2>{t("bookingSetup.checklistTitle")}</h2>
          {blockers.length > 0 && (
            <div className="warning-banner">
              <ul>
                {blockers.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
          )}

          {blockers.length === 0 && slotsChecked && nearestSlotDate === null && (
            <div className="warning-banner">{t("bookingSetup.noUpcomingSlots")}</div>
          )}

          {blockers.length === 0 && nearestSlotDate !== null && bookingAccess === "public" && (
            <>
              <p className="muted">{t("bookingSetup.checklistDone")}</p>
              <p className="muted">
                {t("bookingSetup.nearestSlot", {
                  date: new Date(`${nearestSlotDate}T00:00:00`).toLocaleDateString(localeTag(locale), {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  }),
                })}
              </p>
            </>
          )}

          {bookingAccess !== "public" &&
            (canPublish && published.length > 0 ? (
              <div style={{ marginTop: blockers.length > 0 ? "12rem" : 0 }}>
                <p className="muted">{t("bookingSetup.openPublicHint")}</p>
                <button
                  className="primary-button"
                  type="button"
                  disabled={pending}
                  onClick={openPublicBooking}
                >
                  {t("bookingSetup.openPublic")}
                </button>
              </div>
            ) : (
              <p className="muted" style={{ marginTop: blockers.length > 0 ? "12rem" : 0 }}>
                {t("bookingSetup.operatorPending")}
              </p>
            ))}
        </section>
      )}

      {!isMaster && !guided && <section className="panel booking-panel">
        <h2>{t("bookingSetup.locationsTitle")}</h2>

        {/*
          The address of the public page, and no longer a field.
          
          It used to be typed here, on a screen a new studio had no reason to
          open, and until it was the published booking page existed at no
          address at all. It is now derived from the studio's name when the
          organization is created — see `slugCandidatesFor` — so what is left to
          show is where the page is, which is the one thing the owner came here
          to find out.
        */}
        {publicPageHref && (
          <p className="muted">
            {/* The label is built as an expression rather than written as JSX
                text on purpose. `tests/accessibility.test.ts` refuses any
                literal on this screen that the dictionary does not own, and it
                is right to: everything a client or an owner reads here has to
                exist in three languages. A URL is the exception the rule cannot
                see — «/book/» is a path, not a sentence, and translating it
                would break the link. */}
            {t("bookingSetup.publicPageLabel")}{" "}
            <a className="text-link" href={publicPageHref} target="_blank" rel="noreferrer">
              {publicPageHref}
            </a>
          </p>
        )}
        {locations.length === 0 && <p className="muted">{t("bookingSetup.noLocations")}</p>}

        {locations.map((place) => {
          const deleteBlocker = deleteBlockerOf(place);
          return (
          <details key={place.id} className="calendar-entry">
            <summary>
              {place.name} — {describeStatus(place, t)}
            </summary>
            {/* One padded body, so the heading, the fields and the actions share
                the left edge the summary above them already sits on. */}
            <div className="calendar-entry-body">
            <h3>{t("bookingSetup.editLocation")}</h3>
            <form onSubmit={(event) => updateLocation(event, place.id)} className="inline-form">
              <label>
                {t("bookingSetup.name")}
                <input name="name" defaultValue={place.name} required minLength={2} maxLength={120} />
              </label>
              <label>
                {t("bookingSetup.address")}
                <input name="address" defaultValue={place.address ?? ""} maxLength={300} />
              </label>
              <label>
                {t("bookingSetup.timezone")}
                <select name="timezone" defaultValue={place.timezone}>
                  {timezones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("bookingSetup.status")}
                <select name="status" defaultValue={place.status}>
                  <option value="active">{t("bookingSetup.statusActive")}</option>
                  <option value="archived">{t("bookingSetup.statusArchived")}</option>
                </select>
              </label>
              <button type="submit" className="secondary-button" disabled={!canPublish || pending}>
                {t("common.save")}
              </button>
            </form>

            {canPublish && (
              <div className="inline-actions calendar-entry-actions">
                {confirmDelete === place.id ? (
                  <>
                    <button
                      className="inline-action danger"
                      type="button"
                      disabled={pending}
                      onClick={() => deleteLocation(place.id)}
                    >
                      {t("bookingSetup.deleteConfirm")}
                    </button>
                    <button
                      className="inline-action"
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirmDelete(null)}
                    >
                      {t("common.cancel")}
                    </button>
                    <span className="muted">{t("bookingSetup.deleteHint")}</span>
                  </>
                ) : (
                  <>
                    {place.public_status === "published" ? (
                      <button
                        className="inline-action"
                        type="button"
                        disabled={pending || place.status !== "active"}
                        onClick={() => setPublicStatus(place.id, "paused")}
                      >
                        {t("bookingSetup.unpublish")}
                      </button>
                    ) : (
                      <button
                        className="inline-action"
                        type="button"
                        /* An archived address is not one to put in front of
                           clients: publishing it would offer an address the
                           studio has already stopped using. */
                        disabled={pending || place.status !== "active"}
                        onClick={() => setPublicStatus(place.id, "published")}
                      >
                        {t("bookingSetup.publish")}
                      </button>
                    )}
                    <button
                      className="inline-action danger"
                      type="button"
                      disabled={pending || deleteBlocker !== null}
                      title={deleteBlocker ? t(deleteBlocker) : undefined}
                      onClick={() => {
                        setError(null);
                        setConfirmDelete(place.id);
                      }}
                    >
                      {t("bookingSetup.deleteLocation")}
                    </button>
                    {/* Beside the disabled control rather than inside a tooltip:
                        the answer to "почему кнопка серая" is the whole reason
                        this line exists, and a title attribute has no answer for
                        a finger. */}
                    {deleteBlocker && <span className="muted">{t(deleteBlocker)}</span>}
                  </>
                )}
              </div>
            )}
            </div>
          </details>
          );
        })}

        {canPublish && (
          <>
          <h3>{t("bookingSetup.addLocation")}</h3>
          <form onSubmit={createLocation} className="inline-form">
            <label>
              {t("bookingSetup.name")}
              {/* Only while there is nothing to compare it against: a second
                  address is a different place and needs its own name. */}
              <input
                name="name"
                required
                minLength={2}
                maxLength={120}
                defaultValue={locations.length === 0 ? organizationName : undefined}
              />
            </label>
            <label>
              {t("bookingSetup.slug")}
              <input name="slug" required maxLength={40} pattern="[a-z0-9-]+" />
            </label>
            <label>
              {t("bookingSetup.address")}
              <input name="address" maxLength={300} />
            </label>
            <label>
              {t("bookingSetup.timezone")}
              <select name="timezone" defaultValue="Europe/Chisinau">
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary-button" disabled={pending}>
              {t("bookingSetup.addLocation")}
            </button>
            {/* A full-width row under the fields rather than a cell among them.
                Inside the label it made that one column taller than the rest,
                and with the row aligned on its baseline every other input rose
                out of line with it. */}
            <p className="muted field-note">{t("bookingSetup.slugHint")}</p>
          </form>
          </>
        )}
      </section>}

      {!isMaster && !guided && settingsLocation && (
        <section className="panel booking-panel">
          <h2>{t("bookingSetup.settingsTitle")}</h2>
          <p className="muted">{t("bookingSetup.settingsHint")}</p>

          <label>
            {t("bookingSetup.chooseLocation")}
            <select value={settingsLocation.id} onChange={(event) => setSettingsFor(event.target.value)}>
              {locations.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>

          <form
            key={settingsLocation.id}
            onSubmit={(event) => saveSettings(event, settingsLocation.id)}
            className="inline-form"
          >
            {/* Publishing lives on the address row, beside the state it changes
                and beside the checklist item that asks for it. It was here as
                one field among ten about lead times and buffers, which is how a
                studio ended up with an address nobody could find the switch
                for — and two controls over one field is also how the other one
                silently reverts it. */}
            <label>
              {t("bookingSetup.slotStep")}
              <select name="slot_step_minutes" defaultValue={settingsLocation.slot_step_minutes ?? 15}>
                {SLOT_STEPS.map((step) => (
                  <option key={step} value={step}>
                    {t("bookingSetup.minutes", { count: String(step) })}
                  </option>
                ))}
              </select>
            </label>

            <label>
              {t("bookingSetup.minLead")}
              <input
                name="min_lead_minutes"
                type="number"
                min={0}
                max={43200}
                defaultValue={settingsLocation.min_lead_minutes ?? 120}
              />
            </label>

            <label>
              {t("bookingSetup.maxAdvance")}
              <input
                name="max_advance_days"
                type="number"
                min={1}
                max={365}
                defaultValue={settingsLocation.max_advance_days ?? 60}
              />
            </label>

            <label>
              {t("bookingSetup.bufferBefore")}
              <input
                name="buffer_before_minutes"
                type="number"
                min={0}
                max={240}
                defaultValue={settingsLocation.buffer_before_minutes ?? 0}
              />
            </label>

            <label>
              {t("bookingSetup.bufferAfter")}
              <input
                name="buffer_after_minutes"
                type="number"
                min={0}
                max={240}
                defaultValue={settingsLocation.buffer_after_minutes ?? 10}
              />
            </label>

            <label>
              {t("bookingSetup.confirmationMode")}
              <select
                name="confirmation_mode"
                defaultValue={settingsLocation.confirmation_mode ?? "instant"}
              >
                <option value="instant">{t("bookingSetup.confirmationInstant")}</option>
                <option value="manual">{t("bookingSetup.confirmationManual")}</option>
              </select>
            </label>

            <label>
              {t("bookingSetup.confirmationTtl")}
              <input
                name="confirmation_ttl_minutes"
                type="number"
                min={15}
                max={1440}
                defaultValue={settingsLocation.confirmation_ttl_minutes ?? 120}
              />
            </label>
            <p className="muted">{t("bookingSetup.confirmationTtlHint")}</p>

            <label>
              {t("bookingSetup.verificationMode")}
              <select
                name="verification_mode"
                defaultValue={settingsLocation.verification_mode ?? "off"}
              >
                <option value="off">{t("bookingSetup.verificationOff")}</option>
                <option value="code">{t("bookingSetup.verificationCode")}</option>
              </select>
            </label>

            <label>
              {t("bookingSetup.verificationTtl")}
              <input
                name="verification_ttl_minutes"
                type="number"
                min={3}
                max={60}
                defaultValue={settingsLocation.verification_ttl_minutes ?? 10}
              />
            </label>

            <label>
              {t("bookingSetup.reminderLead")}
              <input
                name="reminder_lead_minutes"
                type="number"
                min={0}
                max={10080}
                defaultValue={settingsLocation.reminder_lead_minutes ?? 1440}
              />
            </label>
            <p className="muted">{t("bookingSetup.reminderHint")}</p>

            <button type="submit" className="primary-button" disabled={!canPublish || pending}>
              {t("common.save")}
            </button>
          </form>
        </section>
      )}

      {!isMaster && !guided && (
        <section className="panel booking-panel">
          <h2>{t("bookingSetup.assignmentTitle")}</h2>
          <p className="muted">{t("bookingSetup.assignmentHint")}</p>

          {specialists.length === 0 && <p className="muted">{t("bookingSetup.noSpecialists")}</p>}

          {specialists.map((person) => (
            <form
              key={person.id}
              onSubmit={(event) => saveAssignment(event, person.id)}
              className="inline-form"
            >
              <h3>{person.name}</h3>
              <div className="public-booking-options">
                {active.map((place) => (
                  <label key={place.id}>
                    <input
                      type="checkbox"
                      name="location_ids"
                      value={place.id}
                      defaultChecked={assignments.some(
                        (row) => row.specialist_id === person.id && row.location_id === place.id,
                      )}
                    />
                    {place.name}
                  </label>
                ))}
              </div>
              <button type="submit" className="secondary-button" disabled={!canManage || pending}>
                {t("common.save")}
              </button>
            </form>
          ))}
        </section>
      )}

      {specialists.length > 0 && active.length > 0 && !guided && (
        <section className="panel booking-panel">
          <h2>{t("bookingSetup.rotaTitle")}</h2>
          <p className="muted">{t("bookingSetup.rotaHint")}</p>

          {!isMaster && (
            <label>
              {t("bookingSetup.specialist")}
              <select
                value={currentSpecialistId}
                onChange={(event) => setRotaSpecialist(event.target.value)}
              >
                {specialists.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!isMaster && (
            <label>
              {t("bookingSetup.location")}
              <select value={currentLocationId} onChange={(event) => setRotaLocation(event.target.value)}>
                {active.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <form
            key={`${currentSpecialistId}:${currentLocationId}`}
            onSubmit={saveRota}
            className="inline-form"
          >
            {weekdays.map((weekday) => {
              const rule = rotaFor(weekday);
              // Only where there is nothing yet: an existing rota is answered
              // with itself, and a week somebody deliberately emptied must not
              // refill on the next visit.
              const suggested =
                currentRota.length === 0 &&
                (DEFAULT_WORKWEEK.weekdays as readonly Weekday[]).includes(weekday);
              return (
                <div key={weekday} className="inline-form">
                  <label>
                    <input
                      type="checkbox"
                      name={`day_${weekday}`}
                      defaultChecked={rule !== null || suggested}
                    />
                    {t(WEEKDAY_KEYS[weekday])}
                  </label>
                  <label>
                    {t("bookingSetup.from")}
                    <input
                      type="time"
                      name={`start_${weekday}`}
                      defaultValue={rule ? timeValue(rule.start_minute) : DEFAULT_WORKWEEK.start}
                    />
                  </label>
                  <label>
                    {t("bookingSetup.to")}
                    <input
                      type="time"
                      name={`end_${weekday}`}
                      defaultValue={rule ? timeValue(rule.end_minute) : DEFAULT_WORKWEEK.end}
                    />
                  </label>
                </div>
              );
            })}

            <label>
              {t("bookingSetup.effectiveFrom")}
              <input
                type="date"
                name="effective_from"
                defaultValue={currentRota[0]?.effective_from ?? today}
              />
            </label>
            <p className="muted">{t("bookingSetup.effectiveFromHint")}</p>

            <button
              type="submit"
              className="primary-button"
              disabled={!(isMaster ? canSaveRota : canManage) || pending}
            >
              {t("bookingSetup.saveRota")}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
