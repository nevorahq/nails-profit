import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { bookingLines, locations, specialists, visitLines, visits } from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import { BOOKING_LINK_TOKEN } from "@/domain/client-return";
import type { ContactChannelMarks } from "@/domain/contact-channels";
import {
  describeSlotStart,
  rankSlotFill,
  slotFillRefusal,
  type SlotFillRefusal,
} from "@/domain/slot-fill";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { findConflict, loadBooking } from "@/lib/booking-service";
import { scopedClientSpecialistId, type ClientActor } from "@/lib/client-access";
import { loadReturnList } from "@/lib/client-return";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { supportedLocales, type AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";

export type SlotFillOrganization = Readonly<{
  name: string;
  locale: AppLocale;
  /** The booking page's slug when it answers, else null — see `publishedBookingSlug`. */
  bookingSlug: string | null;
}>;

export type SlotFillRow = Readonly<{
  clientId: string;
  name: string;
  phone: string;
  channels: ContactChannelMarks;
  lastVisitDay: string;
  intervalDays: number;
  daysSinceLastVisit: number;
  /** Already in the client's language; `BOOKING_LINK_TOKEN` stands for the link. */
  message: string;
}>;

export type SlotFillOffer = Readonly<{
  bookingId: string;
  startsAt: Date;
  timezone: string;
  specialistName: string;
  /** Echoed from the studio, so the caller knows whether `BOOKING_LINK_TOKEN` has a page to point at. */
  bookingSlug: string | null;
  rows: readonly SlotFillRow[];
}>;

export type SlotFillFailure = SlotFillRefusal | "not_found" | "slot_taken";

export type SlotFillOutcome =
  | Readonly<{ ok: true; offer: SlotFillOffer }>
  | Readonly<{ ok: false; failure: SlotFillFailure }>;

function asLocale(value: string | null, fallback: AppLocale): AppLocale {
  return (supportedLocales as readonly string[]).includes(value ?? "") ? (value as AppLocale) : fallback;
}

/**
 * The clients worth writing to about the hour a cancelled appointment left, each
 * with the message already written.
 *
 * Three things have to be true before there is anything to offer: the
 * appointment is cancelled, it has not started, and nobody has taken the hour
 * since — the last asked of the database, because a message about an hour the
 * studio has already sold again is worse than none. Whoever has an hour to
 * offer may also have no one to offer it to; that is an empty list, not a
 * refusal.
 *
 * Nothing is sent from here and nothing is recorded: the desk reads the text,
 * changes it if it likes, and sends it from its own phone, as with «Пора
 * позвать». The pool is that list, so its rules carry over — a master sees
 * only the clients whose latest visit was theirs, and anybody already booked
 * is left alone.
 */
export async function loadSlotFill(
  tx: TenantTransaction,
  actor: ClientActor,
  input: Readonly<{ bookingId: string; organization: SlotFillOrganization; now: Date }>,
): Promise<SlotFillOutcome> {
  const booking = await loadBooking(tx, input.bookingId);
  if (!booking) return { ok: false, failure: "not_found" };
  // A Master offers the hours of their own calendar. Answering «not found»
  // rather than «forbidden» keeps a colleague's id from confirming itself.
  if (!(await mayActOnSpecialist(tx, actor, booking.specialistId))) {
    return { ok: false, failure: "not_found" };
  }

  const refusal = slotFillRefusal(booking, input.now);
  if (refusal) return { ok: false, failure: refusal };

  const taken = await findConflict(tx, {
    specialistId: booking.specialistId,
    workplaceId: booking.workplaceId,
    interval: { start: booking.startsAt, end: booking.endsAt },
    ignoreBookingId: booking.id,
    now: input.now,
  });
  if (taken) return { ok: false, failure: "slot_taken" };

  const [place] = await tx
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.id, booking.locationId))
    .limit(1);
  const timezone = place?.timezone ?? "Europe/Chisinau";

  const [master] = await tx
    .select({ name: specialists.name })
    .from(specialists)
    .where(eq(specialists.id, booking.specialistId))
    .limit(1);
  const specialistName = master?.name ?? "";

  const lines = await tx
    .select({ serviceId: bookingLines.serviceId, name: bookingLines.nameSnapshot })
    .from(bookingLines)
    .where(and(eq(bookingLines.bookingId, booking.id), eq(bookingLines.kind, "service")));

  const due = await loadReturnList(tx, {
    timezone,
    now: input.now,
    viewerSpecialistId: await scopedClientSpecialistId(tx, actor),
  });
  const pool = due.filter((row) => row.phone !== null);

  const servicesOf = await servicesDoneBy(
    tx,
    pool.map((row) => row.clientId),
  );

  const ranked = rankSlotFill(
    pool.map((row) => ({
      clientId: row.clientId,
      name: row.name,
      phone: row.phone,
      overdueDays: row.due.overdueDays,
      lastSpecialistId: row.due.lastSpecialistId,
      serviceIds: servicesOf.get(row.clientId) ?? [],
      row,
    })),
    {
      specialistId: booking.specialistId,
      serviceIds: lines.flatMap((line) => (line.serviceId ? [line.serviceId] : [])),
      clientId: booking.clientId,
    },
  );

  const rows = ranked.map(({ row }): SlotFillRow => {
    // The client's language when the card has one, the studio's otherwise.
    const clientLocale = asLocale(row.locale, input.organization.locale);
    const say = getTranslator(clientLocale);
    const words = {
      name: row.name,
      studio: input.organization.name,
      when: describeSlotStart(booking.startsAt, timezone, localeTag(clientLocale)),
      master: specialistName,
      service: lines
        .map((line) => resolveLocalizedText(line.name, clientLocale, input.organization.locale))
        .filter((name): name is string => name !== null)
        .join(", "),
    };

    return {
      clientId: row.clientId,
      name: row.name,
      phone: row.phone!,
      channels: row.channels,
      lastVisitDay: row.due.lastVisitDay,
      intervalDays: row.due.intervalDays,
      daysSinceLastVisit: row.due.daysSinceLastVisit,
      message: input.organization.bookingSlug
        ? say("slotFill.message", { ...words, link: BOOKING_LINK_TOKEN })
        : say("slotFill.messageNoLink", words),
    };
  });

  return {
    ok: true,
    offer: {
      bookingId: booking.id,
      startsAt: booking.startsAt,
      timezone,
      specialistName,
      bookingSlug: input.organization.bookingSlug,
      rows,
    },
  };
}

/** Every service each of these clients has had done, from the visits that closed. */
async function servicesDoneBy(
  tx: TenantTransaction,
  clientIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (clientIds.length === 0) return new Map();
  const done = new Map<string, Set<string>>();

  const note = (clientId: string | null, serviceId: string | null) => {
    if (!clientId || !serviceId) return;
    const set = done.get(clientId) ?? new Set<string>();
    set.add(serviceId);
    done.set(clientId, set);
  };

  const direct = await tx
    .select({ clientId: visits.clientId, serviceId: visits.serviceId })
    .from(visits)
    .where(and(inArray(visits.clientId, [...clientIds]), isNotNull(visits.serviceId)));
  for (const row of direct) note(row.clientId, row.serviceId);

  // A visit of several services keeps all but the first on its lines.
  const lined = await tx
    .select({ clientId: visits.clientId, serviceId: visitLines.serviceId })
    .from(visitLines)
    .innerJoin(visits, eq(visitLines.visitId, visits.id))
    .where(
      and(
        inArray(visits.clientId, [...clientIds]),
        eq(visitLines.kind, "service"),
        isNotNull(visitLines.serviceId),
      ),
    );
  for (const row of lined) note(row.clientId, row.serviceId);

  return new Map([...done].map(([clientId, set]) => [clientId, [...set]]));
}
