"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { Currency } from "@/domain/money";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import type { AppLocale } from "@/i18n/messages";
import { formatMoneyMinor } from "@/lib/format";
import {
  validatePublicContact,
  type PublicContactError,
  type PublicContactField,
} from "@/lib/public-booking-ux";

type Location = {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  confirmation_mode: "instant" | "manual";
  verification_mode: "off" | "code";
};
type AddOn = {
  id: string;
  name: string;
  price_delta_minor: number;
  duration_delta_minutes: number;
};
type Service = {
  id: string;
  name: string;
  price_minor: number;
  duration_minutes: number;
  add_ons: AddOn[];
  specialists: { id: string; name: string }[];
};
type Slot = {
  starts_at: string;
  ends_at: string;
  specialist_id: string;
  specialist_name: string;
  duration_minutes: number;
  price_minor: number;
};

type NearestDate = { date: string; slot_count: number };
type PendingAction = "catalog" | "availability" | "hold" | "verification" | "booking" | null;

type Profile = {
  slug: string;
  name: string;
  locale: AppLocale;
  currency: Currency;
  notification_channel: "email" | "sms";
  locations: Location[];
};

type Contact = {
  name: string;
  phone: string;
  email: string | null;
  locale: string;
  legalAccepted: boolean;
};

function dateInZone(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * The proof of work section 7.9 asks a suspected bot for.
 *
 * Sixteen bits is about sixty-five thousand hashes — a fraction of a second on
 * a phone, and a cost per attempt that a loop feels. It runs on the main thread
 * on purpose: a worker would need its own file and a build step for something
 * that finishes before the button finishes its transition.
 */
async function solveChallenge(nonce: string, bits: number): Promise<string | null> {
  const encoder = new TextEncoder();
  const wholeBytes = Math.floor(bits / 8);
  const remainder = bits % 8;

  for (let attempt = 0; attempt < 5_000_000; attempt += 1) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(`${nonce}:${attempt}`)),
    );

    let solved = true;
    for (let index = 0; index < wholeBytes && solved; index += 1) solved = digest[index] === 0;
    if (solved && remainder > 0) solved = digest[wholeBytes] >> (8 - remainder) === 0;
    if (solved) return String(attempt);
  }
  return null;
}

type Challenge = { nonce: string; difficulty_bits: number };

function challengeOf(body: unknown): Challenge | null {
  const error = (body as { error?: { code?: string; details?: Challenge } })?.error;
  return error?.code === "CHALLENGE_REQUIRED" && error.details?.nonce ? error.details : null;
}

function apiErrorMessage(body: unknown, fallback: string, t: ReturnType<typeof getTranslator>) {
  const code = apiErrorCode(body);
  if (code === "SLOT_UNAVAILABLE") return t("publicBooking.slotUnavailable");
  if (code === "HOLD_EXPIRED") return t("publicBooking.holdExpired");
  if (code === "VERIFICATION_FAILED") return t("publicBooking.verifyFailed");
  if (code === "VERIFICATION_EXPIRED") return t("publicBooking.verifyExpired");
  if (code === "VERIFICATION_LOCKED") return t("publicBooking.verifyLocked");
  return fallback;
}

function apiErrorCode(body: unknown) {
  return (body as { error?: { code?: string } })?.error?.code ?? null;
}

export function PublicBookingFlow({ profile }: { profile: Profile }) {
  const t = useMemo(() => getTranslator(profile.locale), [profile.locale]);
  const [locationId, setLocationId] = useState(profile.locations[0]?.id ?? "");
  const location = profile.locations.find((entry) => entry.id === locationId) ?? profile.locations[0];
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState("");
  const service = services.find((entry) => entry.id === serviceId) ?? null;
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [specialistId, setSpecialistId] = useState("any");
  const [date, setDate] = useState(() => dateInZone(location.timezone));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [nearestDates, setNearestDates] = useState<NearestDate[]>([]);
  const [searched, setSearched] = useState(false);
  const [held, setHeld] = useState<{ token: string; expiresAt: string; slot: Slot } | null>(null);
  /**
   * Kept in state rather than read from the form at the last moment, because
   * the verification step replaces that form: section 7.8 requires the details
   * a client typed to survive every step that follows, including a wrong code.
   */
  const [contact, setContact] = useState<Contact | null>(null);
  const [stage, setStage] = useState<"contact" | "code">("contact");
  const [result, setResult] = useState<{ status: string; manageUrl: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>("catalog");
  const pending = pendingAction !== null;
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PublicContactField, string>>>({});
  const [codeError, setCodeError] = useState<string | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  /**
   * One anonymous visit, for section 7.10's funnel. Minted here and forgotten
   * when the tab closes: it identifies a sitting at this form, not a person and
   * not a device, and the server records it only against product events.
   */
  const [sessionKey] = useState(() => crypto.randomUUID());
  const sessionHeader = useMemo(() => ({ "x-booking-session": sessionKey }), [sessionKey]);

  const money = (amount: number) =>
    formatMoneyMinor(amount, profile.currency, localeTag(profile.locale));

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/public/booking/${profile.slug}/catalog?location_id=${locationId}`, {
      headers: { "x-booking-session": sessionKey },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message ?? "catalog");
        return body.data.services as Service[];
      })
      .then((next) => {
        if (!active) return;
        setServices(next);
        setServiceId(next[0]?.id ?? "");
        setAddOnIds([]);
        setSpecialistId("any");
        setSlots([]);
        setNearestDates([]);
        setSearched(false);
        setHeld(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof TypeError ? t("publicBooking.offline") : t("publicBooking.error"));
      })
      .finally(() => active && setPendingAction(null));
    return () => {
      active = false;
    };
  }, [locationId, profile.slug, sessionKey, t]);

  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0 || codeError) errorSummaryRef.current?.focus();
  }, [fieldErrors, codeError]);

  const quote = useMemo(() => {
    if (!service) return { price: 0, duration: 0 };
    const selected = service.add_ons.filter((addOn) => addOnIds.includes(addOn.id));
    return {
      price: service.price_minor + selected.reduce((sum, addOn) => sum + addOn.price_delta_minor, 0),
      duration:
        service.duration_minutes +
        selected.reduce((sum, addOn) => sum + addOn.duration_delta_minutes, 0),
    };
  }, [service, addOnIds]);

  /**
   * A public mutation, with the challenge solved and retried once if the
   * server asks for one. The client never sees a puzzle screen: section 7.9
   * wants the cost paid by whoever is looping, not by whoever is booking.
   */
  async function postPublic(url: string, body: unknown, extraHeaders: Record<string, string> = {}) {
    const send = (challengeHeader: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...sessionHeader,
          ...extraHeaders,
          ...challengeHeader,
        },
        body: JSON.stringify(body),
      });

    const first = await send();
    if (first.status !== 403) return first;

    const challenge = challengeOf(await first.clone().json().catch(() => null));
    if (!challenge) return first;

    const solution = await solveChallenge(challenge.nonce, challenge.difficulty_bits);
    return solution ? send({ "x-booking-challenge": `${challenge.nonce}:${solution}` }) : first;
  }

  async function loadTimes(nextDate: string) {
    if (!service) return;
    setPendingAction("availability");
    setError(null);
    setHeld(null);
    setSearched(false);
    setSlots([]);
    setNearestDates([]);
    const query = new URLSearchParams({
      location_id: locationId,
      service_id: service.id,
      add_on_ids: addOnIds.join(","),
      specialist_id: specialistId,
      date: nextDate,
    });
    try {
      const response = await fetch(
        `/api/v1/public/booking/${profile.slug}/availability?${query.toString()}`,
        { headers: sessionHeader },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(apiErrorMessage(body, t("publicBooking.error"), t));
        return;
      }
      setSlots(body.data.slots);
      setNearestDates(body.data.nearest_dates ?? []);
      setSearched(true);
    } catch {
      setError(t("publicBooking.offline"));
    } finally {
      setPendingAction(null);
    }
  }

  async function findTimes(event: FormEvent) {
    event.preventDefault();
    await loadTimes(date);
  }

  async function chooseNearestDate(nextDate: string) {
    setDate(nextDate);
    await loadTimes(nextDate);
  }

  async function chooseSlot(slot: Slot) {
    if (!service) return;
    setPendingAction("hold");
    setError(null);
    try {
      const response = await postPublic(`/api/v1/public/booking/${profile.slug}/holds`, {
        location_id: locationId,
        service_id: service.id,
        add_on_ids: addOnIds,
        specialist_id: slot.specialist_id,
        starts_at: slot.starts_at,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(apiErrorMessage(body, t("publicBooking.error"), t));
        return;
      }
      setHeld({ token: body.data.hold_token, expiresAt: body.data.expires_at, slot: body.data.slot });
      setIdempotencyKey(crypto.randomUUID());
    } catch {
      setError(t("publicBooking.offline"));
    } finally {
      setPendingAction(null);
    }
  }

  function validationMessage(field: PublicContactField, issue: PublicContactError) {
    if (field === "name" && issue === "nameTooShort") return t("publicBooking.nameTooShort");
    if (field === "phone" && issue === "phoneInvalid") return t("publicBooking.phoneInvalid");
    if (field === "email" && issue === "emailInvalid") return t("publicBooking.emailInvalid");
    if (field === "legalAccepted") return t("publicBooking.consentRequired");
    return t("publicBooking.required");
  }

  function clearFieldError(field: PublicContactField) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!service || !held) return;
    const data = new FormData(event.currentTarget);
    const entered: Contact = {
      name: String(data.get("name") ?? "").trim(),
      phone: String(data.get("phone") ?? "").trim(),
      email: String(data.get("email") ?? "").trim() || null,
      locale: String(data.get("locale") ?? profile.locale),
      legalAccepted: data.get("legalAccepted") === "on",
    };
    const issues = validatePublicContact(
      { ...entered, email: entered.email ?? "" },
      profile.notification_channel === "email",
    );
    if (Object.keys(issues).length > 0) {
      setFieldErrors(
        Object.fromEntries(
          Object.entries(issues).map(([field, issue]) => [
            field,
            validationMessage(field as PublicContactField, issue as PublicContactError),
          ]),
        ),
      );
      return;
    }
    setFieldErrors({});
    setContact(entered);

    if (location.verification_mode === "code") {
      if (await requestCode(entered)) setStage("code");
      return;
    }
    await createBooking(entered);
  }

  /** Section 7.2 step 7: the studio asked for the contact to be proven. */
  async function requestCode(entered: Contact) {
    if (!held) return false;
    setPendingAction("verification");
    setError(null);
    try {
      const response = await postPublic(`/api/v1/public/booking/${profile.slug}/verify`, {
        action: "request",
        hold_token: held.token,
        phone: entered.phone,
        email: entered.email,
        locale: entered.locale,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = apiErrorCode(body);
        if (code === "HOLD_EXPIRED") setHeld(null);
        setError(
          response.status >= 500
            ? t("publicBooking.providerFailure")
            : apiErrorMessage(body, t("publicBooking.error"), t),
        );
        return false;
      }
      return true;
    } catch {
      setError(t("publicBooking.offline"));
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!held || !contact) return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    if (!code.trim()) {
      setCodeError(t("publicBooking.required"));
      return;
    }
    setCodeError(null);
    setPendingAction("verification");
    setError(null);
    try {
      const response = await postPublic(`/api/v1/public/booking/${profile.slug}/verify`, {
        action: "confirm",
        hold_token: held.token,
        code,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (apiErrorCode(body) === "HOLD_EXPIRED") setHeld(null);
        setError(apiErrorMessage(body, t("publicBooking.error"), t));
        return;
      }
    } catch {
      setError(t("publicBooking.offline"));
      return;
    } finally {
      setPendingAction(null);
    }
    await createBooking(contact);
  }

  async function createBooking(entered: Contact) {
    if (!service || !held) return;
    setPendingAction("booking");
    setError(null);
    try {
      const response = await postPublic(
        `/api/v1/public/booking/${profile.slug}/bookings`,
        {
          hold_token: held.token,
          service_id: service.id,
          add_on_ids: addOnIds,
          name: entered.name,
          phone: entered.phone,
          email: entered.email,
          locale: entered.locale,
          legal_accepted: entered.legalAccepted,
        },
        { "idempotency-key": idempotencyKey },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (apiErrorCode(body) === "HOLD_EXPIRED") setHeld(null);
        setError(apiErrorMessage(body, t("publicBooking.error"), t));
        return;
      }
      setResult({ status: body.data.status, manageUrl: body.data.manage_url });
    } catch {
      setError(t("publicBooking.offline"));
    } finally {
      setPendingAction(null);
    }
  }

  if (result) {
    return (
      <main className="public-booking-shell">
        <section className="public-booking-card public-booking-success">
          <span className="eyebrow">{profile.name}</span>
          <h1>{t("publicBooking.success")}</h1>
          <p>{t(result.status === "confirmed" ? "publicBooking.confirmed" : "publicBooking.pending")}</p>
          <Link className="primary-button" href={result.manageUrl}>
            {t("publicBooking.manage")}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="public-booking-shell">
      <header className="public-booking-header">
        <span className="brand">{profile.name}</span>
        <span className="role-badge">{t("publicBooking.eyebrow")}</span>
      </header>
      <section className="public-booking-intro">
        <span className="eyebrow">Nail Profit OS</span>
        <h1>{t("publicBooking.title")}</h1>
        <p>{t("publicBooking.subtitle")}</p>
      </section>

      <section className="public-booking-card" aria-busy={pending}>
        {!held ? (
          <form onSubmit={findTimes} noValidate>
            <div className="public-booking-grid">
              <label>
                {t("publicBooking.location")}
                <select value={locationId} disabled={pending} onChange={(event) => { setPendingAction("catalog"); setError(null); setSlots([]); setNearestDates([]); setLocationId(event.target.value); }}>
                  {profile.locations.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("publicBooking.service")}
                <select
                  value={serviceId}
                  disabled={pending}
                  onChange={(event) => {
                    setServiceId(event.target.value);
                    setAddOnIds([]);
                    setSpecialistId("any");
                    setSlots([]);
                    setNearestDates([]);
                    setSearched(false);
                  }}
                >
                  {services.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("publicBooking.specialist")}
                <select value={specialistId} disabled={pending} onChange={(event) => { setSpecialistId(event.target.value); setSlots([]); setNearestDates([]); setSearched(false); }}>
                  <option value="any">{t("publicBooking.anySpecialist")}</option>
                  {service?.specialists.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("publicBooking.date")}
                <input type="date" value={date} min={dateInZone(location.timezone)} disabled={pending} onChange={(event) => { setDate(event.target.value); setSlots([]); setNearestDates([]); setSearched(false); }} required />
              </label>
            </div>

            {service && service.add_ons.length > 0 && (
              <fieldset className="public-booking-options">
                <legend>{t("publicBooking.addOns")}</legend>
                {service.add_ons.map((addOn) => (
                  <label key={addOn.id}>
                    <input
                      type="checkbox"
                      checked={addOnIds.includes(addOn.id)}
                      disabled={pending}
                      onChange={(event) =>
                        setAddOnIds((current) => {
                          setSearched(false);
                          setSlots([]);
                          setNearestDates([]);
                          return event.target.checked
                            ? [...current, addOn.id]
                            : current.filter((id) => id !== addOn.id);
                        })
                      }
                    />
                    <span>{addOn.name}</span>
                    <small>{money(addOn.price_delta_minor)}</small>
                  </label>
                ))}
              </fieldset>
            )}

            <div className="public-booking-quote">
              <strong>{money(quote.price)}</strong>
              <div>
                <span>{t("publicBooking.minutes", { count: quote.duration })}</span>
                <span>{t("publicBooking.timezone", { zone: location.timezone })}</span>
              </div>
            </div>
            <button className="primary-button" type="submit" disabled={pending || !service}>
              {pendingAction === "availability" || pendingAction === "catalog"
                ? t("publicBooking.loadingAvailability")
                : t("publicBooking.findTime")}
            </button>
          </form>
        ) : stage === "code" ? (
          <form onSubmit={confirmCode} noValidate>
            <div className="public-booking-summary">
              <div>
                <span>{t("publicBooking.yourChoice")}</span>
                <strong>{service?.name}</strong>
              </div>
              <div>
                <span>{held.slot.specialist_name}</span>
                <strong>{new Intl.DateTimeFormat(localeTag(profile.locale), { timeZone: location.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(held.slot.starts_at))}</strong>
              </div>
            </div>
            <h2>{t("publicBooking.verifyTitle")}</h2>
            <p className="muted">{t("publicBooking.verifyHint")}</p>
            {codeError && (
              <div className="form-error-summary" role="alert" tabIndex={-1} ref={errorSummaryRef}>
                <strong>{t("publicBooking.errorSummary")}</strong>
                <a href="#booking-code">{codeError}</a>
              </div>
            )}
            <div className="public-booking-grid">
              <label htmlFor="booking-code">
                {t("publicBooking.verifyCode")}
                <input
                  id="booking-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  placeholder={t("publicBooking.codePlaceholder")}
                  aria-invalid={Boolean(codeError)}
                  aria-describedby={codeError ? "booking-code-error" : undefined}
                  onChange={() => setCodeError(null)}
                  required
                />
                {codeError && <span id="booking-code-error" className="field-error">{codeError}</span>}
              </label>
            </div>
            <div className="button-row">
              <button
                className="secondary-button"
                type="button"
                disabled={pending}
                onClick={() => setStage("contact")}
              >
                {t("publicBooking.change")}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={pending}
                onClick={() => contact && requestCode(contact)}
              >
                {t("publicBooking.verifyResend")}
              </button>
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? t("publicBooking.confirming") : t("publicBooking.verifySubmit")}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitContact} noValidate>
            <div className="public-booking-summary">
              <div>
                <span>{t("publicBooking.yourChoice")}</span>
                <strong>{service?.name}</strong>
              </div>
              <div>
                <span>{held.slot.specialist_name}</span>
                <strong>{new Intl.DateTimeFormat(localeTag(profile.locale), { timeZone: location.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(held.slot.starts_at))}</strong>
              </div>
              <p>{t("publicBooking.heldUntil", { time: new Intl.DateTimeFormat(localeTag(profile.locale), { timeZone: location.timezone, timeStyle: "short" }).format(new Date(held.expiresAt)) })}</p>
            </div>
            {Object.keys(fieldErrors).length > 0 && (
              <div className="form-error-summary" role="alert" tabIndex={-1} ref={errorSummaryRef}>
                <strong>{t("publicBooking.errorSummary")}</strong>
                <ul>
                  {Object.entries(fieldErrors).map(([field, message]) => (
                    <li key={field}><a href={`#booking-${field}`}>{message}</a></li>
                  ))}
                </ul>
              </div>
            )}
            <div className="public-booking-grid">
              {/* The placeholder shows the shape each answer should take; the
                  default carries what was already typed, so a client sent back
                  here by a wrong code finds their answers still in place. */}
              <label htmlFor="booking-name">
                {t("publicBooking.name")}
                <input id="booking-name" name="name" autoComplete="name" placeholder={t("publicBooking.namePlaceholder")} required minLength={2} defaultValue={contact?.name ?? ""} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "booking-name-error" : undefined} onChange={() => clearFieldError("name")} />
                {fieldErrors.name && <span id="booking-name-error" className="field-error">{fieldErrors.name}</span>}
              </label>
              <label htmlFor="booking-phone">
                {t("publicBooking.phone")}
                <input id="booking-phone" name="phone" type="tel" autoComplete="tel" placeholder={t("publicBooking.phonePlaceholder")} required defaultValue={contact?.phone ?? ""} aria-invalid={Boolean(fieldErrors.phone)} aria-describedby={fieldErrors.phone ? "booking-phone-error" : undefined} onChange={() => clearFieldError("phone")} />
                {fieldErrors.phone && <span id="booking-phone-error" className="field-error">{fieldErrors.phone}</span>}
              </label>
              <label htmlFor="booking-email">
                {t(profile.notification_channel === "email" ? "publicBooking.emailRequired" : "publicBooking.email")}
                <input id="booking-email" name="email" type="email" autoComplete="email" placeholder={t("publicBooking.emailPlaceholder")} required={profile.notification_channel === "email"} defaultValue={contact?.email ?? ""} aria-invalid={Boolean(fieldErrors.email)} aria-describedby={fieldErrors.email ? "booking-email-error" : undefined} onChange={() => clearFieldError("email")} />
                {fieldErrors.email && <span id="booking-email-error" className="field-error">{fieldErrors.email}</span>}
              </label>
              <label htmlFor="booking-locale">
                {t("publicBooking.language")}
                <select id="booking-locale" name="locale" defaultValue={contact?.locale ?? profile.locale}>
                  <option value="ru">Русский</option><option value="ro">Română</option><option value="en">English</option>
                </select>
              </label>
            </div>
            <label className="consent-field public-booking-consent">
              <input id="booking-legalAccepted" name="legalAccepted" type="checkbox" required aria-invalid={Boolean(fieldErrors.legalAccepted)} aria-describedby={fieldErrors.legalAccepted ? "booking-consent-error" : undefined} onChange={() => clearFieldError("legalAccepted")} />
              <span>{t("publicBooking.consent")} <Link href="/terms">{t("legal.termsLink")}</Link> · <Link href="/privacy">{t("legal.privacyLink")}</Link></span>
              {fieldErrors.legalAccepted && <span id="booking-consent-error" className="field-error public-booking-consent-error">{fieldErrors.legalAccepted}</span>}
            </label>
            <div className="button-row">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setHeld(null);
                  setStage("contact");
                }}
              >
                {t("publicBooking.change")}
              </button>
              <button className="primary-button" type="submit" disabled={pending}>
                {pending
                  ? t("publicBooking.confirming")
                  : location.verification_mode === "code"
                    ? t("publicBooking.verifySend")
                    : t("publicBooking.confirm")}
              </button>
            </div>
          </form>
        )}

        {!held && pendingAction === "availability" && (
          <div className="public-booking-loading" role="status" aria-live="polite">
            <span className="sr-only">{t("publicBooking.loadingAvailability")}</span>
            {Array.from({ length: 6 }, (_, index) => <span key={index} aria-hidden="true" />)}
          </div>
        )}
        {pendingAction === "hold" && (
          <p className="public-booking-status" role="status" aria-live="polite">
            {t("publicBooking.holdingSlot")}
          </p>
        )}

        {!held && slots.length > 0 && (
          <div className="public-booking-slots">
            <h2>{t("publicBooking.chooseTime")}</h2>
            <div>
              {slots.map((slot) => (
                <button key={`${slot.starts_at}:${slot.specialist_id}`} type="button" onClick={() => chooseSlot(slot)} disabled={pending}>
                  <strong>{new Intl.DateTimeFormat(localeTag(profile.locale), { timeZone: location.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(slot.starts_at))}</strong>
                  <span>{slot.specialist_name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!pending && !held && searched && service && slots.length === 0 && date && nearestDates.length > 0 && (
          <section className="public-booking-nearest" aria-labelledby="nearest-dates-title">
            <h2 id="nearest-dates-title">{t("publicBooking.nearestDates")}</h2>
            <div>
              {nearestDates.map((entry) => (
                <button key={entry.date} type="button" onClick={() => chooseNearestDate(entry.date)}>
                  <strong>{new Intl.DateTimeFormat(localeTag(profile.locale), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${entry.date}T12:00:00Z`))}</strong>
                  <span>{t("publicBooking.slotCount", { count: entry.slot_count })}</span>
                </button>
              ))}
            </div>
            <p className="muted">{t("publicBooking.noSlots")}</p>
          </section>
        )}
        {!pending && !held && searched && service && slots.length === 0 && date && nearestDates.length === 0 && (
          <div className="public-booking-empty" role="status">
            <strong>{t("publicBooking.noSlotsTitle")}</strong>
            <p className="muted">{t("publicBooking.noSlots")}</p>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
