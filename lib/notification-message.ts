import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";

/**
 * The transactional templates of roadmap section 7.7, and the text each one
 * turns into.
 *
 * Rendering lives apart from the queue and the provider so that the wording —
 * the part a studio owner reads and a client receives — can be tested with
 * nothing running. It is also the only place that knows a message has both a
 * subject and a body: SMS uses the body alone, email needs both, and the
 * difference belongs here rather than in the sending code.
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
  code: string;
}>;

export type RenderedNotification = Readonly<{ subject: string; body: string }>;

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

  return {
    subject: t(`${prefix}.subject` as MessageKey, params),
    body: t(`${prefix}.body` as MessageKey, params),
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
