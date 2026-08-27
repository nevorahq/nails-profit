"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { formatLocalTime, parseLocalTime, weekdays, type Weekday } from "@/domain/timezone";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
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
  locations,
  specialists,
  assignments,
  rota,
  bookingAccess,
  organizationSlug,
  canManage,
  canPublish,
  canSaveRota,
  role,
  ownSpecialistId,
  locale,
}: {
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
  role?: MemberRole;
  ownSpecialistId?: string | null;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
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
  const [publicSlug, setPublicSlug] = useState(organizationSlug ?? "");
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
   * What is still missing before a client could book anything. Every studio
   * hits this list in the same order, and finding out which step was skipped
   * from an empty public page is the part that wastes an afternoon.
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
    bookingAccess !== "public" ? "bookingSetup.blockerAccess" : null,
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

  /**
   * The organization's slug, saved through the organization endpoint rather
   * than the location one — it names the whole public page, not any single
   * address on it. It is edited here because this is the screen that page is
   * assembled on; every physical address below is a row that page will list.
   */
  async function saveSlug(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await send("/api/v1/organizations/settings", "PATCH", { slug: publicSlug.trim() || null });
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

    await send("/api/v1/availability/rules", "PUT", {
      specialist_id: currentSpecialistId,
      location_id: currentLocationId,
      effective_from: String(data.get("effective_from") ?? ""),
      intervals,
    });
  }

  const currentRota = rota.filter(
    (rule) => rule.specialist_id === currentSpecialistId && rule.location_id === currentLocationId,
  );
  const rotaFor = (weekday: Weekday) => currentRota.find((rule) => rule.weekday === weekday) ?? null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {!isMaster && (
        <section className="panel booking-panel">
          <h2>{t("bookingSetup.checklistTitle")}</h2>
          {blockers.length === 0 ? (
            <p className="muted">{t("bookingSetup.checklistDone")}</p>
          ) : (
            <div className="warning-banner">
              <ul>
                {blockers.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {!isMaster && <section className="panel booking-panel">
        <h2>{t("bookingSetup.locationsTitle")}</h2>
        <p className="muted">{t("bookingSetup.locationsHint")}</p>

        {canPublish && (
          <form className="inline-form booking-public-address" onSubmit={saveSlug}>
            <label>
              {t("bookingSetup.publicAddress")}
              <input
                value={publicSlug}
                disabled={pending}
                placeholder="studio-name"
                autoComplete="off"
                onChange={(event) => setPublicSlug(event.target.value.toLowerCase())}
              />
            </label>
            <button className="secondary-button" type="submit" disabled={pending}>
              {t("bookingSetup.publicAddressSave")}
            </button>
          </form>
        )}
        {publicPageHref && (
          <p className="muted">
            {/* The label is built as an expression rather than written as JSX
                text on purpose. `tests/accessibility.test.ts` refuses any
                literal on this screen that the dictionary does not own, and it
                is right to: everything a client or an owner reads here has to
                exist in three languages. A URL is the exception the rule cannot
                see — «/book/» is a path, not a sentence, and translating it
                would break the link. */}
            <a className="text-link" href={publicPageHref} target="_blank" rel="noreferrer">
              {publicPageHref}
            </a>
          </p>
        )}
        <p className="muted">{t("bookingSetup.publicAddressHint")}</p>

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
              <input name="name" required minLength={2} maxLength={120} />
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

      {!isMaster && settingsLocation && (
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

      {!isMaster && (
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

      {specialists.length > 0 && active.length > 0 && (
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
              return (
                <div key={weekday} className="inline-form">
                  <label>
                    <input type="checkbox" name={`day_${weekday}`} defaultChecked={rule !== null} />
                    {t(WEEKDAY_KEYS[weekday])}
                  </label>
                  <label>
                    {t("bookingSetup.from")}
                    <input
                      type="time"
                      name={`start_${weekday}`}
                      defaultValue={rule ? timeValue(rule.start_minute) : "09:00"}
                    />
                  </label>
                  <label>
                    {t("bookingSetup.to")}
                    <input
                      type="time"
                      name={`end_${weekday}`}
                      defaultValue={rule ? timeValue(rule.end_minute) : "18:00"}
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
