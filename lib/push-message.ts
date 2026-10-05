import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import type { StaffNotificationTemplate } from "@/lib/notification-message";

/**
 * What a push says on a locked phone, phase 7.
 *
 * A lock screen is read by whoever is standing next to the phone, so it says
 * exactly enough to decide whether to pick it up: what happened, when, which
 * service, and the client's name — the name a master would say out loud
 * anyway. Never the phone number or the address: those are a client's contact
 * details, and they are not what the decision needs.
 *
 * The facts this renders are therefore the whole of what a push can carry, and
 * the type is the guarantee — there is no field a phone could be passed in.
 *
 * In the studio's language: the reader is the studio, as for its emails.
 */
export type PushTemplate = Extract<
  StaffNotificationTemplate,
  | "booking.staff_requested"
  | "booking.staff_booked"
  | "booking.staff_rescheduled"
  | "booking.staff_cancelled"
  | "booking.staff_released"
  | "booking.staff_request_reminder"
>;

/** The events that wake a phone. The rest stay in the bell and the inbox. */
export const pushTemplates: readonly PushTemplate[] = [
  "booking.staff_requested",
  "booking.staff_booked",
  "booking.staff_rescheduled",
  "booking.staff_cancelled",
  "booking.staff_released",
  "booking.staff_request_reminder",
];

export function isPushTemplate(template: string): template is PushTemplate {
  return (pushTemplates as readonly string[]).includes(template);
}

const TITLE: Record<PushTemplate, MessageKey> = {
  "booking.staff_requested": "push.title.requested",
  "booking.staff_booked": "push.title.booked",
  "booking.staff_rescheduled": "push.title.rescheduled",
  "booking.staff_cancelled": "push.title.cancelled",
  "booking.staff_released": "push.title.released",
  "booking.staff_request_reminder": "push.title.reminder",
};

export type PushFacts = Readonly<{
  template: PushTemplate;
  locale: AppLocale;
  /** Already formatted on the location's clock. */
  when: string;
  /** The booked services, joined; empty when the booking has none. */
  service: string;
  /** The name the appointment was booked under; null for a placeholder. */
  client: string | null;
  /**
   * Whose chair, for a reader whose chair it is not — the owner, the front
   * desk. Null for the master herself and for a studio of one.
   */
  specialist: string | null;
  bookingId: string;
}>;

export type PushPayload = Readonly<{
  title: string;
  body: string;
  /** Opened by `public/sw.js`; always inside `/app`. */
  url: string;
  /** One line per appointment on the lock screen. */
  tag: string;
}>;

export function renderPush(facts: PushFacts): PushPayload {
  const t = getTranslator(facts.locale);
  const body = [
    facts.when,
    facts.service,
    facts.client ?? t("push.noClient"),
    facts.specialist ? t("push.toSpecialist", { specialist: facts.specialist }) : "",
  ]
    .filter((part) => part.trim() !== "")
    .join(" · ");

  return {
    title: t(TITLE[facts.template]),
    body,
    url: `/app/calendar/${facts.bookingId}`,
    tag: `booking:${facts.bookingId}`,
  };
}

/** «Проверить»: what a working device shows, in the studio's language. */
export function renderTestPush(locale: AppLocale): PushPayload {
  const t = getTranslator(locale);
  return {
    title: t("push.title.test"),
    body: t("push.body.test"),
    url: "/app",
    tag: "test",
  };
}
