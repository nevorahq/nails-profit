import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { renderNotificationHtml } from "@/lib/notification-email";

/**
 * The transactional templates of roadmap section 7.7, and the text each one
 * turns into.
 *
 * Rendering lives apart from the queue and the provider so that the wording —
 * the part a studio owner reads and a client receives — can be tested with
 * nothing running. It is also the only place that knows what shapes a message
 * comes in: SMS sends the plain body alone, email carries a subject and an
 * HTML alternative beside it, and that difference belongs here rather than in
 * the sending code.
 */
export const bookingNotificationTemplates = [
  "booking.verification_code",
  "booking.pending_confirmation",
  "booking.confirmed",
  /**
   * The answer to a request: somebody looked at it and took it, and the client
   * is told who. Separate from `booking.confirmed` because that one also covers
   * an appointment that was never a request — taken at the desk, or confirmed by
   * the studio's own instant setting — where "принята мастером" would announce a
   * decision nobody made.
   */
  "booking.request_accepted",
  "booking.rescheduled",
  "booking.reminder",
  "booking.cancelled",
  "booking.link_reissued",
  /**
   * After the visit: thanks, and the way back. The appointment is over, so
   * there is nothing left to manage — the link is the studio's booking page,
   * not the client's manage page.
   */
  "booking.visit_completed",
  /**
   * The one message addressed to the studio rather than to the client: a
   * request is waiting for somebody to answer it, and nothing else tells them.
   * Everything above reaches a client's phone or inbox; this reaches the master
   * the appointment was booked with, and the owner when that master has no
   * account linked yet.
   */
  "booking.staff_requested",
] as const;

export type BookingNotificationTemplate = (typeof bookingNotificationTemplates)[number];

/**
 * The template a queued row names, or null when this build has never heard of
 * it.
 *
 * A row is written by whichever deployment took the booking and sent by
 * whichever one drains the queue, and those are not always the same one: a
 * message added on a laptop pointed at the production database outlives the
 * build that wrote it. Reading the column as a `BookingNotificationTemplate`
 * without asking is what turns that into a client-visible fault — `KEY_PREFIX`
 * returns `undefined`, and the renderer cheerfully sends "undefined.body".
 */
export function asBookingNotificationTemplate(value: string): BookingNotificationTemplate | null {
  return (bookingNotificationTemplates as readonly string[]).includes(value)
    ? (value as BookingNotificationTemplate)
    : null;
}

const KEY_PREFIX: Record<BookingNotificationTemplate, string> = {
  "booking.verification_code": "notify.verification",
  "booking.pending_confirmation": "notify.pending",
  "booking.confirmed": "notify.confirmed",
  "booking.request_accepted": "notify.requestAccepted",
  "booking.rescheduled": "notify.rescheduled",
  "booking.reminder": "notify.reminder",
  "booking.cancelled": "notify.cancelled",
  "booking.link_reissued": "notify.linkReissued",
  "booking.visit_completed": "notify.visitCompleted",
  "booking.staff_requested": "notify.staffRequested",
};

/** Templates whose reader is the studio, not the client. */
export const staffNotificationTemplates: readonly BookingNotificationTemplate[] = [
  "booking.staff_requested",
];

export type NotificationFacts = Readonly<{
  template: BookingNotificationTemplate;
  locale: AppLocale;
  studioName: string;
  /** Already formatted in the location's zone; a client reads local time only. */
  when: string;
  /**
   * The master the appointment is with, by the name on their card. Only one
   * template names a person; the rest are handed it and ignore it.
   */
  specialist: string;
  link: string;
  /**
   * Whether losing the link costs the reader their way in.
   *
   * A manage link is a token minted for one appointment and held nowhere else:
   * the client has no account, and nothing about it can be guessed. The studio's
   * booking page and the staff calendar are the opposite — public, or behind a
   * login the reader already has. Only the first kind earns the plain URL under
   * the button, and the side that mints the link is the side that knows which
   * kind it is.
   */
  linkIsOneTime: boolean;
  code: string;
}>;

/**
 * Templates that end in something the reader does somewhere else, and so have
 * a button in the email and a link in the SMS. The verification code is the
 * one that does not: the code is the whole message, and there is nowhere to
 * send anybody.
 */
const CTA_TEMPLATES: readonly BookingNotificationTemplate[] = bookingNotificationTemplates.filter(
  (template) => template !== "booking.verification_code",
);

export type RenderedNotification = Readonly<{
  subject: string;
  /** Plain text: the whole message for SMS, the fallback part of an email. */
  body: string;
  /** The email's HTML alternative. SMS never sends it. */
  html: string;
}>;

/**
 * One set of words, two shapes.
 *
 * The catalogue holds the sentence and the button's label separately, so the
 * link is not welded into the middle of a sentence — that is what makes a
 * button possible at all. Plain text puts them back together the way it always
 * read (`…подтверждена.` then `Перенести или отменить: <link>`), which is what
 * an SMS still gets; the HTML version turns the same two strings into a
 * paragraph and a button.
 *
 * A message whose link came out empty — a studio with no public page, so
 * nowhere to send the client back to — renders as the sentence alone rather
 * than as a button pointing at nothing.
 */
export function renderNotification(facts: NotificationFacts): RenderedNotification {
  const t = getTranslator(facts.locale);
  const prefix = KEY_PREFIX[facts.template];
  const params = {
    studio: facts.studioName,
    when: facts.when,
    specialist: facts.specialist,
    link: facts.link,
    code: facts.code,
  };

  const lead = t(`${prefix}.body` as MessageKey, params);
  const action =
    CTA_TEMPLATES.includes(facts.template) && facts.link !== ""
      ? {
          label: t(`${prefix}.cta` as MessageKey, params),
          url: facts.link,
          /*
           * The button is an `<a>`, and a sanitizer that strips those leaves it
           * as dead words. Printing the address under it costs a line of grey
           * text and is the difference between a client reaching their
           * appointment and not — but only where the address is theirs alone.
           * A studio's booking page is on their own materials; repeating it
           * here buys nothing but noise.
           */
          ...(facts.linkIsOneTime ? { fallbackLabel: t("notify.linkFallback") } : {}),
        }
      : null;

  return {
    subject: t(`${prefix}.subject` as MessageKey, params),
    body: action ? `${lead}\n\n${action.label}: ${action.url}` : lead,
    html: renderNotificationHtml({ locale: facts.locale, body: lead, action }),
  };
}

/**
 * The appointment time as the client will read it: the location's zone, the
 * client's language.
 *
 * Not the server's zone and not the studio's language — a message saying 14:00
 * to someone whose appointment is at 15:00 local time is worse than no message,
 * and it is exactly what formatting on the server's default produces.
 */
export function formatAppointmentTime(at: Date, timezone: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}
