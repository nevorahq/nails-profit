"use client";

import { useState } from "react";

import { contactWays, type ContactChannel } from "@/domain/contact-links";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { useDismissiblePanel } from "@/lib/use-dismissible-panel";

/**
 * Brand names, not words: nobody translates WhatsApp, and a dictionary entry
 * per language for a name that is the same in all three would be three places
 * to spell it wrong. «Позвонить» is a verb and lives in the dictionary.
 */
const BRAND: Partial<Record<ContactChannel, string>> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  viber: "Viber",
};

/**
 * The client's number, as the four things a person at the desk might do with it.
 *
 * It used to be a `tel:` link and nothing else — one tap, straight into the
 * dialler — and that is still what the first item does. The cost of the change
 * is that call is now two taps, which is why it is the first item and looks
 * like the primary one: «клиент опаздывает» is answered by ringing, and the
 * studio should not have to read a menu to do it.
 *
 * What the other three buy is the case the phone does not cover. A client who
 * does not pick up may well answer a message, and the number the studio already
 * has is the address for all of them — nothing here asks anybody to store a
 * messenger handle they would have to keep up to date.
 */
export function ClientContact({ phone, locale }: { phone: string; locale: AppLocale }) {
  const t = getTranslator(locale);
  const [open, setOpen] = useState(false);
  const { root, trigger } = useDismissiblePanel(open, () => setOpen(false));
  const ways = contactWays(phone);

  // A number in a shape none of these services accepts is still a number the
  // desk can read aloud. It is printed, and it does nothing.
  if (ways.length === 0) return <span className="client-contact-plain">{phone}</span>;

  return (
    <span className="client-contact" ref={root}>
      <button
        type="button"
        className="calendar-call"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {phone}
      </button>

      {open && (
        <span className="client-contact-ways" role="menu" aria-label={t("contact.ways")}>
          {ways.map((way) => (
            <a
              key={way.channel}
              className="client-contact-way"
              role="menuitem"
              data-channel={way.channel}
              href={way.href}
              /*
               * A messenger opens in its own application, and the two that are
               * web addresses open a page that is not this one. `_blank` keeps
               * the calendar where it was — the desk is mid-conversation with
               * the studio's own screen, and losing the day it was on is how a
               * link like this gets clicked once and never again.
               */
              target={way.href.startsWith("https:") ? "_blank" : undefined}
              rel={way.href.startsWith("https:") ? "noreferrer" : undefined}
              onClick={() => setOpen(false)}
            >
              {BRAND[way.channel] ?? t("contact.call")}
            </a>
          ))}
        </span>
      )}
    </span>
  );
}
