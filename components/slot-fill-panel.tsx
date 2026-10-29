"use client";

import { useEffect, useState } from "react";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { MessageComposer } from "@/components/message-composer";
import type { ContactChannelMarks } from "@/domain/contact-channels";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";

type Offer = Readonly<{
  booking_path: string | null;
  clients: readonly Readonly<{
    client_id: string;
    name: string;
    phone: string;
    channels: ContactChannelMarks;
    last_visit_day: string;
    interval_days: number;
    days_since_last_visit: number;
    message: string;
  }>[];
}>;

/**
 * «Освободилось время» under a cancelled appointment: whom to write to about it.
 *
 * Asked on the card where the gap is, and in the same breath as the
 * cancellation — the desk that has just taken an hour back is the desk that can
 * still fill it. The answer is a few clients from «Пора позвать», each with the
 * message already written; the studio edits it and sends it from its own phone
 * (`MessageComposer`). Nothing is sent from here and nothing is stored.
 *
 * Asked for rather than loaded with the page: the calendar lists a day's
 * appointments, and a day with several cancellations should not run the return
 * list for each. Opened by itself only when the cancellation was made on this
 * very card.
 */
export function SlotFillPanel({
  bookingId,
  locale,
  localeTag,
  autoOpen = false,
}: {
  bookingId: string;
  locale: AppLocale;
  localeTag: string;
  autoOpen?: boolean;
}) {
  const t = useTranslator(locale);
  const register = useRegister();
  // Already loading when the card was just cancelled: the effect below asks.
  const [offer, setOffer] = useState<Offer | "loading" | null>(autoOpen ? "loading" : null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(autoOpen);

  async function ask(): Promise<{ offer: Offer } | { error: string }> {
    const response = await fetch(`/api/v1/bookings/${bookingId}/slot-fill`);
    const body = (await response.json().catch(() => null)) as {
      data?: Offer;
      error?: { code: string; message: string };
    } | null;
    if (response.ok && body?.data) return { offer: body.data };
    return {
      error: body?.error
        ? getErrorMessage(body.error.code, body.error.message, locale, register)
        : t("slotFill.failed"),
    };
  }

  function show(answer: { offer: Offer } | { error: string }) {
    if ("offer" in answer) {
      setOffer(answer.offer);
      return;
    }
    setOffer(null);
    setError(answer.error);
  }

  async function look() {
    setOffer("loading");
    setError(null);
    show(await ask());
  }

  // The card that was just cancelled asks at once. Cleaned up so that Strict
  // Mode's second run, not its first, is the one that answers.
  useEffect(() => {
    if (!autoOpen) return;
    let current = true;
    void ask().then((answer) => {
      if (current) show(answer);
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, bookingId]);

  function toggle() {
    // The first opening asks; a later one only shows what is already here.
    if (!open && offer === null && error === null) void look();
    setOpen(!open);
  }

  const day = (value: string) =>
    new Intl.DateTimeFormat(localeTag, { day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(`${value}T00:00:00.000Z`),
    );

  return (
    <section className="slot-fill" aria-label={t("slotFill.title")}>
      <h3>{t("slotFill.title")}</h3>
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        onClick={toggle}
      >
        {t("slotFill.show")}
      </button>

      {open && (
        <>
          <p className="muted">{t("slotFill.hint")}</p>
          {offer === "loading" && <p className="muted">{t("slotFill.loading")}</p>}

          {error && (
            <>
              <p className="field-error" role="alert">
                {error}
              </p>
              <button type="button" className="secondary-button" onClick={() => void look()}>
                {t("slotFill.retry")}
              </button>
            </>
          )}

          {offer && offer !== "loading" && offer.clients.length === 0 && (
            <p className="muted">{t("slotFill.none")}</p>
          )}

          {offer && offer !== "loading" && offer.clients.length > 0 && (
            <ul className="slot-fill-list">
              {offer.clients.map((row) => (
                <SlotFillRow
                  key={row.client_id}
                  row={row}
                  bookingPath={offer.booking_path}
                  locale={locale}
                  line={t("slotFill.line", {
                    date: day(row.last_visit_day),
                    interval: row.interval_days,
                    since: row.days_since_last_visit,
                  })}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SlotFillRow({
  row,
  bookingPath,
  locale,
  line,
}: {
  row: Offer["clients"][number];
  bookingPath: string | null;
  locale: AppLocale;
  line: string;
}) {
  const t = useTranslator(locale);
  const [open, setOpen] = useState(false);

  return (
    <li>
      <div className="slot-fill-who">
        <strong>{row.name}</strong>
        <span className="muted">{line}</span>
      </div>
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("clientReturn.write")}
      </button>
      {open && (
        <MessageComposer
          phone={row.phone}
          channels={row.channels}
          message={row.message}
          bookingPath={bookingPath}
          locale={locale}
        />
      )}
    </li>
  );
}
