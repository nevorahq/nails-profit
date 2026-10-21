import type { Translate } from "@/i18n/t";

/**
 * A visit as an entry in the client's own calendar.
 *
 * The studio already reminds the client once, a day ahead by default, through
 * whatever channel they left. What it cannot do is put the visit where the
 * rest of their week is: next to the dentist, on the phone that alarms by
 * itself, offline, and at whatever notice the client prefers. A calendar entry
 * does that for nothing — no message is paid for and nothing is scheduled here.
 *
 * Two ways in, because the phones differ. An `.ics` file is what an iPhone,
 * Outlook and most Android calendars open with «Add»; Google Calendar on the
 * web takes its event in a link instead, and cannot be handed a file.
 */
export type VisitEvent = Readonly<{
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  /** The master, and in the file only the way back to this page. */
  details: string;
  /** Moves on every change, so a re-added event replaces the one before it. */
  sequence: number;
  /** A request the studio has not answered yet: in the calendar, but marked as not settled. */
  tentative: boolean;
}>;

/** What the calendar entry is built from: a subset of the manage page's booking. */
export type VisitView = Readonly<{
  organization_name: string;
  location: { name: string; address: string | null };
  specialist: { name: string };
  starts_at: string;
  ends_at: string;
  status: string;
  version: number;
  lines: readonly { kind: string; name: string }[];
}>;

/** How long before the visit the calendar's own alarm goes off. */
export const VISIT_ALARM_MINUTES = 120;

export function visitEvent(
  view: VisitView,
  t: Translate,
  manageUrl: string | null,
): VisitEvent {
  const services = view.lines.filter((line) => line.kind === "service");
  const what = (services.length > 0 ? services : view.lines).map((line) => line.name).join(" + ");
  const details = [t("publicBooking.calendarMaster", { name: view.specialist.name })];
  if (manageUrl) details.push(t("publicBooking.calendarManage", { url: manageUrl }));
  return {
    title: what ? `${what} — ${view.organization_name}` : view.organization_name,
    startsAt: new Date(view.starts_at),
    endsAt: new Date(view.ends_at),
    location: [view.location.name, view.location.address].filter(Boolean).join(", ") || null,
    details: details.join("\n"),
    sequence: view.version,
    tentative: view.status === "pending_confirmation",
  };
}

/** `20261022T080000Z`: both formats take UTC this way, so no zone table is needed. */
function utc(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 §3.3.11: backslash, semicolon and comma are escaped, newlines written as `\n`. */
function text(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 §3.1: no line longer than 75 octets, continued on the next with a
 * leading space. Octets, not characters — «Маникюр» is two bytes a letter — and
 * never through the middle of one, which is why this walks code points.
 */
function fold(line: string) {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + width > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * The file. `bookingId` makes the UID: the same appointment added twice — once,
 * and again after a move — is one event to a calendar that honours `SEQUENCE`.
 */
export function visitIcs(event: VisitEvent, bookingId: string, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nail Profit OS//Online booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:booking-${bookingId}@nail-profit-os`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(event.startsAt)}`,
    `DTEND:${utc(event.endsAt)}`,
    `SUMMARY:${text(event.title)}`,
    ...(event.location ? [`LOCATION:${text(event.location)}`] : []),
    `DESCRIPTION:${text(event.details)}`,
    `STATUS:${event.tentative ? "TENTATIVE" : "CONFIRMED"}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${text(event.title)}`,
    `TRIGGER:-PT${VISIT_ALARM_MINUTES}M`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/**
 * Google's «add an event» link. It sets no alarm — Google applies the
 * client's own default — and is built without the manage link: the URL is
 * Google's to log, and the token in that link is the key to the appointment.
 */
export function googleCalendarUrl(event: VisitEvent) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${utc(event.startsAt)}/${utc(event.endsAt)}`,
    details: event.details,
  });
  if (event.location) params.set("location", event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
