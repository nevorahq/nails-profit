"use client";

import Link from "next/link";
import { useState } from "react";

import { ContactIcon } from "@/components/icons";
import { useTranslator } from "@/components/lexicon-provider";
import { offeredChannels, type ContactChannelMarks } from "@/domain/contact-channels";
import { messageWays, type MessageChannel } from "@/domain/contact-links";
import type { AppLocale } from "@/i18n/messages";

/** What the server leaves in the message where the booking page's address goes. */
export const BOOKING_LINK_TOKEN = "__BOOKING_LINK__";

/** How many rows show before «Показать ещё»: a list worth working through, not a wall. */
const FIRST_ROWS = 10;

export type ReturnPanelRow = Readonly<{
  clientId: string;
  name: string;
  phone: string | null;
  channels: ContactChannelMarks;
  lastVisitDay: string;
  intervalDays: number;
  daysSinceLastVisit: number;
  /** Already in the client's language; `BOOKING_LINK_TOKEN` stands for the link. */
  message: string;
}>;

const NAMES: Record<MessageChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  viber: "Viber",
  sms: "SMS",
};

/**
 * «Пора позвать»: the clients past their own rhythm, and a way to write to each.
 *
 * Nothing is sent from here. The studio presses «Написать», picks how, and
 * the message opens in its own phone already written — with the booking page
 * when there is one to send. An automatic campaign would be a different
 * product, with consent and unsubscribe to answer for; this is the desk doing
 * what it would do anyway, minus the typing.
 *
 * The address is put into the text here rather than on the server, because
 * the server does not reliably know which host it was reached on — see
 * `BookingLink`.
 */
export function ClientReturnPanel({
  rows,
  bookingPath,
  locale,
  localeTag,
}: {
  rows: readonly ReturnPanelRow[];
  /** `/book/<slug>` when the page answers, else null and the message asks to write back. */
  bookingPath: string | null;
  locale: AppLocale;
  localeTag: string;
}) {
  const t = useTranslator(locale);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  if (rows.length === 0) return null;

  const textOf = (row: ReturnPanelRow) =>
    bookingPath
      ? row.message.replace(BOOKING_LINK_TOKEN, new URL(bookingPath, window.location.origin).toString())
      : row.message;

  async function copy(row: ReturnPanelRow) {
    try {
      await navigator.clipboard.writeText(textOf(row));
      setCopied(row.clientId);
    } catch {
      // A browser that refuses the clipboard still leaves the link working.
    }
  }

  const day = (value: string) =>
    new Intl.DateTimeFormat(localeTag, { day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(`${value}T00:00:00.000Z`),
    );

  const shown = all ? rows : rows.slice(0, FIRST_ROWS);

  return (
    <section className="panel client-return" aria-labelledby="client-return-title">
      <h2 id="client-return-title">
        {t("clientReturn.title")} <span className="muted">{rows.length}</span>
      </h2>
      <p className="muted">{t("clientReturn.hint")}</p>
      <ul className="client-return-list">
        {shown.map((row) => {
          const ways = open === row.clientId ? messageWays(row.phone, textOf(row), offeredChannels(row.channels)) : [];
          return (
            <li key={row.clientId}>
              <div className="client-return-who">
                <Link className="text-link" href={`/app/clients/${row.clientId}`}>
                  {row.name}
                </Link>
                <span className="muted">
                  {t("clientReturn.line", {
                    date: day(row.lastVisitDay),
                    interval: row.intervalDays,
                    since: row.daysSinceLastVisit,
                  })}
                </span>
              </div>
              {row.phone ? (
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={open === row.clientId}
                  onClick={() => {
                    setOpen(open === row.clientId ? null : row.clientId);
                    setCopied(null);
                  }}
                >
                  {t("clientReturn.write")}
                </button>
              ) : (
                <span className="muted">{t("clientReturn.noPhone")}</span>
              )}
              {open === row.clientId && (
                <div className="client-return-ways">
                  {ways.map((way) => (
                    <a
                      key={way.channel}
                      className="secondary-button"
                      data-channel={way.channel}
                      href={way.href}
                      target={way.href.startsWith("https:") ? "_blank" : undefined}
                      rel={way.href.startsWith("https:") ? "noreferrer" : undefined}
                      // Telegram and Viber open an empty chat: the words go on
                      // the clipboard on the way there.
                      onClick={way.carriesText ? undefined : () => void copy(row)}
                    >
                      {way.channel !== "sms" && <ContactIcon name={way.channel} />}
                      {NAMES[way.channel]}
                    </a>
                  ))}
                  <button type="button" className="secondary-button" onClick={() => void copy(row)}>
                    {t("clientReturn.copy")}
                  </button>
                  {copied === row.clientId && (
                    <p className="muted" role="status">
                      {t("clientReturn.copied")}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!all && rows.length > FIRST_ROWS && (
        <button type="button" className="text-link" onClick={() => setAll(true)}>
          {t("clientReturn.more", { count: rows.length - FIRST_ROWS })}
        </button>
      )}
    </section>
  );
}
