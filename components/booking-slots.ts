import { clockAt } from "@/components/calendar-free-time";
import type { ServiceLine } from "@/components/service-lines-field";
import { parseLocalDate } from "@/domain/timezone";

/**
 * The question the appointment form asks of `GET /api/v1/availability/slots`,
 * and how it reads the answer.
 *
 * Kept out of the component because both halves have rules: the request is
 * worth sending only for a real date and a real sitting, and the times are the
 * wall clock of the location, never of the browser.
 */

/**
 * The request for one day's free times, or null while there is nothing to ask.
 *
 * Null for a date half-typed into the field and for a sitting with no service:
 * the first would be a 422 the desk never caused, the second would ask how long
 * nothing takes. Add-ons ride on the service they were chosen for, in the
 * `service:addOn|service` shape the endpoint reads.
 */
export function slotsUrl(input: {
  locationId: string;
  specialistId: string;
  date: string;
  lines: readonly ServiceLine[];
}): string | null {
  if (!input.locationId || !input.specialistId || input.lines.length === 0) return null;
  if (!parseLocalDate(input.date)) return null;

  const services = input.lines
    .map((line) => [line.serviceId, ...line.addOnIds].join(":"))
    .join("|");

  const query = new URLSearchParams({
    location_id: input.locationId,
    specialist_id: input.specialistId,
    date: input.date,
    services,
  });
  return `/api/v1/availability/slots?${query.toString()}`;
}

/** Slot starts as the `HH:MM` the time field takes, in the location's own zone. */
export function slotTimes(slots: readonly string[], timezone: string): string[] {
  return slots.map((slot) => clockAt(slot, timezone));
}
