"use client";

import { useId, useState } from "react";

import { ContactIcon } from "@/components/icons";
import { useTranslator } from "@/components/lexicon-provider";
import { withBookingLink } from "@/domain/client-return";
import { offeredChannels, type ContactChannelMarks } from "@/domain/contact-channels";
import { messageWays, type MessageChannel } from "@/domain/contact-links";
import type { AppLocale } from "@/i18n/messages";

const NAMES: Record<MessageChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  viber: "Viber",
  sms: "SMS",
};

/**
 * A written message the desk can change, and the ways to send it.
 *
 * Nothing is sent from here. The text sits in a field, already written; the
 * studio edits it if it likes, presses a messenger, and the message opens in
 * its own phone with the edited words. An automatic campaign would be a
 * different product, with consent and unsubscribe to answer for.
 *
 * The edit is the point of the field and the thing a link must not outrun: the
 * hrefs are built from what is in the box now, not from what was written for it.
 * The address is put into the text here rather than on the server, because the
 * server does not reliably know which host it was reached on — see
 * `BookingLink`. Mounted only once the desk has asked for it, so reading
 * `window` here never meets a server render.
 */
export function MessageComposer({
  phone,
  channels,
  message,
  bookingPath,
  locale,
}: {
  phone: string | null;
  channels: ContactChannelMarks;
  /** Already in the client's language; `BOOKING_LINK_TOKEN` stands for the link. */
  message: string;
  /** `/book/<slug>` when the page answers, else null and the message was written without a link. */
  bookingPath: string | null;
  locale: AppLocale;
}) {
  const t = useTranslator(locale);
  const fieldId = useId();
  const [text, setText] = useState(() =>
    withBookingLink(message, bookingPath ? new URL(bookingPath, window.location.origin).toString() : null),
  );
  const [copied, setCopied] = useState(false);

  const ways = text.trim() === "" ? [] : messageWays(phone, text, offeredChannels(channels));

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still leaves the link working.
    }
  }

  return (
    <div className="message-composer">
      <label htmlFor={fieldId} className="muted">
        {t("messageComposer.label")}
      </label>
      <textarea
        id={fieldId}
        value={text}
        rows={5}
        onChange={(event) => {
          setText(event.target.value);
          setCopied(false);
        }}
      />
      <div className="client-return-ways">
        {ways.length === 0 && (
          <p className="muted" role="status">
            {t("messageComposer.empty")}
          </p>
        )}
        {ways.map((way) => (
          <a
            key={way.channel}
            className="secondary-button"
            data-channel={way.channel}
            href={way.href}
            target={way.href.startsWith("https:") ? "_blank" : undefined}
            rel={way.href.startsWith("https:") ? "noreferrer" : undefined}
            // Telegram and Viber open an empty chat: the words go on the
            // clipboard on the way there.
            onClick={way.carriesText ? undefined : () => void copy()}
          >
            {way.channel !== "sms" && <ContactIcon name={way.channel} />}
            {NAMES[way.channel]}
          </a>
        ))}
        {text.trim() !== "" && (
          <button type="button" className="secondary-button" onClick={() => void copy()}>
            {t("clientReturn.copy")}
          </button>
        )}
        {copied && (
          <p className="muted" role="status">
            {t("clientReturn.copied")}
          </p>
        )}
      </div>
    </div>
  );
}
