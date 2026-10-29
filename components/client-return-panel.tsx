"use client";

import Link from "next/link";
import { useState } from "react";

import { useTranslator } from "@/components/lexicon-provider";
import { MessageComposer } from "@/components/message-composer";
import type { ContactChannelMarks } from "@/domain/contact-channels";
import type { AppLocale } from "@/i18n/messages";

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

/**
 * «Пора позвать»: the clients past their own rhythm, and a way to write to each.
 *
 * Nothing is sent from here. The studio presses «Написать», edits the text if
 * it likes, picks how, and the message opens in its own phone — with the
 * booking page when there is one to send (`MessageComposer`). An automatic
 * campaign would be a different product, with consent and unsubscribe to
 * answer for; this is the desk doing what it would do anyway, minus the typing.
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
  const [all, setAll] = useState(false);

  if (rows.length === 0) return null;

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
        {shown.map((row) => (
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
                  onClick={() => setOpen(open === row.clientId ? null : row.clientId)}
                >
                  {t("clientReturn.write")}
                </button>
              ) : (
                <span className="muted">{t("clientReturn.noPhone")}</span>
              )}
              {open === row.clientId && (
                <MessageComposer
                  phone={row.phone}
                  channels={row.channels}
                  message={row.message}
                  bookingPath={bookingPath}
                  locale={locale}
                />
              )}
            </li>
        ))}
      </ul>
      {!all && rows.length > FIRST_ROWS && (
        <button type="button" className="text-link" onClick={() => setAll(true)}>
          {t("clientReturn.more", { count: rows.length - FIRST_ROWS })}
        </button>
      )}
    </section>
  );
}
