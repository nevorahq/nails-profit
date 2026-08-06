"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import type { AppLocale } from "@/i18n/messages";
import { formatMoneyMinor } from "@/lib/format";

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

type Profile = {
  slug: string;
  name: string;
  locale: AppLocale;
  currency: "MDL" | "EUR";
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

function apiErrorMessage(body: unknown, fallback: string, t: ReturnType<typeof getTranslator>) {
  const code = (body as { error?: { code?: string } })?.error?.code;
  if (code === "SLOT_UNAVAILABLE") return t("publicBooking.slotUnavailable");
  if (code === "HOLD_EXPIRED") return t("publicBooking.holdExpired");
  if (code === "VERIFICATION_FAILED") return t("publicBooking.verifyFailed");
  if (code === "VERIFICATION_EXPIRED") return t("publicBooking.verifyExpired");
  if (code === "VERIFICATION_LOCKED") return t("publicBooking.verifyLocked");
  return fallback;
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
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const money = (amount: number) =>
    formatMoneyMinor(amount, profile.currency, localeTag(profile.locale));

  useEffect(() => {
    let active = true;
    fetch(`/api/v1/public/booking/${profile.slug}/catalog?location_id=${locationId}`)
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
        setSearched(false);
        setHeld(null);
      })
      .catch(() => active && setError(t("publicBooking.error")))
      .finally(() => active && setPending(false));
    return () => {
      active = false;
    };
  }, [locationId, profile.slug, t]);

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

  async function findTimes(event: FormEvent) {
    event.preventDefault();
    if (!service) return;
    setPending(true);
    setError(null);
    setHeld(null);
    setSearched(false);
    const query = new URLSearchParams({
      location_id: locationId,
      service_id: service.id,
      add_on_ids: addOnIds.join(","),
      specialist_id: specialistId,
      date,
    });
    const response = await fetch(
      `/api/v1/public/booking/${profile.slug}/availability?${query.toString()}`,
    );
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(apiErrorMessage(body, t("publicBooking.error"), t));
      return;
    }
    setSlots(body.data.slots);
    setSearched(true);
  }

  async function chooseSlot(slot: Slot) {
    if (!service) return;
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/public/booking/${profile.slug}/holds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        location_id: locationId,
        service_id: service.id,
        add_on_ids: addOnIds,
        specialist_id: slot.specialist_id,
        starts_at: slot.starts_at,
      }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(apiErrorMessage(body, t("publicBooking.error"), t));
      return;
    }
    setHeld({ token: body.data.hold_token, expiresAt: body.data.expires_at, slot: body.data.slot });
    setIdempotencyKey(crypto.randomUUID());
  }

  async function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!service || !held) return;
    const data = new FormData(event.currentTarget);
    const entered: Contact = {
      name: String(data.get("name") ?? ""),
      phone: String(data.get("phone") ?? ""),
      email: String(data.get("email") ?? "") || null,
      locale: String(data.get("locale") ?? profile.locale),
      legalAccepted: data.get("legalAccepted") === "on",
    };
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
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/public/booking/${profile.slug}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request",
        hold_token: held.token,
        phone: entered.phone,
        email: entered.email,
        locale: entered.locale,
      }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(apiErrorMessage(body, t("publicBooking.error"), t));
      return false;
    }
    return true;
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!held || !contact) return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/public/booking/${profile.slug}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", hold_token: held.token, code }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(apiErrorMessage(body, t("publicBooking.error"), t));
      return;
    }
    await createBooking(contact);
  }

  async function createBooking(entered: Contact) {
    if (!service || !held) return;
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/public/booking/${profile.slug}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        hold_token: held.token,
        service_id: service.id,
        add_on_ids: addOnIds,
        name: entered.name,
        phone: entered.phone,
        email: entered.email,
        locale: entered.locale,
        legal_accepted: entered.legalAccepted,
      }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(apiErrorMessage(body, t("publicBooking.error"), t));
      return;
    }
    setResult({ status: body.data.status, manageUrl: body.data.manage_url });
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
          <form onSubmit={findTimes}>
            <div className="public-booking-grid">
              <label>
                {t("publicBooking.location")}
                <select value={locationId} onChange={(event) => { setPending(true); setError(null); setLocationId(event.target.value); }}>
                  {profile.locations.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("publicBooking.service")}
                <select
                  value={serviceId}
                  onChange={(event) => {
                    setServiceId(event.target.value);
                    setAddOnIds([]);
                    setSpecialistId("any");
                    setSlots([]);
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
                <select value={specialistId} onChange={(event) => { setSpecialistId(event.target.value); setSearched(false); }}>
                  <option value="any">{t("publicBooking.anySpecialist")}</option>
                  {service?.specialists.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("publicBooking.date")}
                <input type="date" value={date} min={dateInZone(location.timezone)} onChange={(event) => { setDate(event.target.value); setSearched(false); }} required />
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
                      onChange={(event) =>
                        setAddOnIds((current) => {
                          setSearched(false);
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
              <span>{t("publicBooking.minutes", { count: quote.duration })}</span>
            </div>
            <button className="primary-button" type="submit" disabled={pending || !service}>
              {t("publicBooking.findTime")}
            </button>
          </form>
        ) : stage === "code" ? (
          <form onSubmit={confirmCode}>
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
            <div className="public-booking-grid">
              <label>
                {t("publicBooking.verifyCode")}
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  required
                />
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
          <form onSubmit={submitContact}>
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
            <div className="public-booking-grid">
              {/* Defaults, not placeholders: a client sent back here by a wrong
                  code must find what they typed still typed. */}
              <label>{t("publicBooking.name")}<input name="name" autoComplete="name" required minLength={2} defaultValue={contact?.name ?? ""} /></label>
              <label>{t("publicBooking.phone")}<input name="phone" type="tel" autoComplete="tel" required defaultValue={contact?.phone ?? ""} /></label>
              <label>{t("publicBooking.email")}<input name="email" type="email" autoComplete="email" defaultValue={contact?.email ?? ""} /></label>
              <label>
                {t("publicBooking.language")}
                <select name="locale" defaultValue={contact?.locale ?? profile.locale}>
                  <option value="ru">Русский</option><option value="ro">Română</option><option value="en">English</option>
                </select>
              </label>
            </div>
            <label className="consent-field public-booking-consent">
              <input name="legalAccepted" type="checkbox" required />
              <span>{t("publicBooking.consent")} <Link href="/terms">{t("legal.termsLink")}</Link> · <Link href="/privacy">{t("legal.privacyLink")}</Link></span>
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
        {!pending && !held && searched && service && slots.length === 0 && date && (
          <p className="muted">{t("publicBooking.noSlots")}</p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
