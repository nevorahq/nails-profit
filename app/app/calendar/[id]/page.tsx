import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";

import { auditEvents, clients, locations, specialists, users, visits, workplaces } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { can, hasConstraint } from "@/domain/rbac";
import { formatLocalTime, toZonedParts } from "@/domain/timezone";
import { resolveLocalizedText } from "@/i18n/localized-text";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { mayActOnSpecialist } from "@/lib/booking-access";
import { bookingLinesOf, loadBooking } from "@/lib/booking-service";
import { formatMoneyMinor } from "@/lib/format";
import { requireWorkspace } from "@/lib/workspace";

/**
 * One appointment in full, roadmap section 7.2: "открыть карточку записи с
 * audit history".
 *
 * Who moved this, when, and from what is the first question asked when a client
 * says they were told a different time, and it cannot be answered from the
 * booking row — that row only knows where the appointment ended up.
 */
export default async function BookingCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { membership, locale, currency } = await requireWorkspace();
  const t = getTranslator(locale);
  const tag = localeTag(locale);

  if (!can(membership.role, "bookings", "read")) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("calendar.noAccess")}</p>
      </main>
    );
  }

  const { id } = await params;

  const card = await withTenant(membership.organizationId, async (tx) => {
    const booking = await loadBooking(tx, id);
    if (!booking) return null;
    // A Master opens their own appointments. Answering "not found" rather than
    // "forbidden" keeps a colleague's id from being confirmed as a real one.
    if (!(await mayActOnSpecialist(tx, membership, booking.specialistId))) return null;

    const lines = await bookingLinesOf(tx, booking.id);

    const [place] = await tx
      .select({ name: locations.name, timezone: locations.timezone, address: locations.address })
      .from(locations)
      .where(eq(locations.id, booking.locationId))
      .limit(1);

    const [person] = await tx
      .select({ name: specialists.name })
      .from(specialists)
      .where(eq(specialists.id, booking.specialistId))
      .limit(1);

    const [client] = booking.clientId
      ? await tx
          .select({ name: clients.name, phone: clients.normalizedPhone, email: clients.email })
          .from(clients)
          .where(eq(clients.id, booking.clientId))
          .limit(1)
      : [];

    const [workplace] = booking.workplaceId
      ? await tx
          .select({ name: workplaces.name })
          .from(workplaces)
          .where(eq(workplaces.id, booking.workplaceId))
          .limit(1)
      : [];

    const [visit] = await tx
      .select({ id: visits.id, completedAt: visits.completedAt })
      .from(visits)
      .where(eq(visits.bookingId, booking.id))
      .limit(1);

    const history = await tx
      .select({
        id: auditEvents.id,
        eventType: auditEvents.eventType,
        before: auditEvents.before,
        after: auditEvents.after,
        createdAt: auditEvents.createdAt,
        actorEmail: users.email,
      })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.actorUserId, users.id))
      .where(and(eq(auditEvents.entityType, "booking"), eq(auditEvents.entityId, booking.id)))
      .orderBy(desc(auditEvents.createdAt));

    return { booking, lines, place, person, client, workplace, visit, history };
  });

  if (!card) {
    return (
      <main className="app-shell">
        <p className="warning-banner">{t("calendar.notFound")}</p>
        <Link className="text-link" href="/app/calendar">
          {t("calendar.back")}
        </Link>
      </main>
    );
  }

  const timezone = card.place?.timezone ?? "UTC";
  const start = toZonedParts(card.booking.startsAt, timezone);
  const end = toZonedParts(card.booking.endsAt, timezone);

  // Section 6.1: an Analyst reads client history without phone or email.
  const hideContacts = hasConstraint(membership.role, "clients", "exclude_pii");
  const total = card.lines.reduce((sum, line) => sum + line.priceMinor, 0);

  return (
    <main className="app-shell">
      <h1>{t("calendar.card")}</h1>

      <p>
        <Link className="text-link" href="/app/calendar">
          {t("calendar.back")}
        </Link>
      </p>

      <section className="panel">
        <h2>
          {start.year}-{String(start.month).padStart(2, "0")}-{String(start.day).padStart(2, "0")}{" "}
          {formatLocalTime(start.minutes)}–{formatLocalTime(end.minutes)}
        </h2>
        <p className="muted">{t("calendar.inZone", { zone: timezone })}</p>

        <dl className="calendar-facts">
          <dt>{t("calendar.status")}</dt>
          <dd>{t(`bookingStatus.${card.booking.status}` as MessageKey)}</dd>

          <dt>{t("calendar.specialist")}</dt>
          <dd>{card.person?.name ?? "—"}</dd>

          <dt>{t("calendar.location")}</dt>
          <dd>
            {card.place?.name ?? "—"}
            {card.place?.address && <span className="unit-hint">{card.place.address}</span>}
            {card.workplace && <span className="unit-hint">{card.workplace.name}</span>}
          </dd>

          <dt>{t("calendar.client")}</dt>
          <dd>
            {card.client?.name ?? <span className="muted">{t("calendar.noClient")}</span>}
            {card.client && !hideContacts && card.client.phone && (
              <span className="unit-hint">{card.client.phone}</span>
            )}
            {card.client && !hideContacts && card.client.email && (
              <span className="unit-hint">{card.client.email}</span>
            )}
          </dd>

          <dt>{t("calendar.source")}</dt>
          <dd>{t(`bookingSource.${card.booking.source}` as MessageKey)}</dd>

          {card.booking.cancellationReason && (
            <>
              <dt>{t("calendar.reason")}</dt>
              <dd>{t(`cancelReason.${card.booking.cancellationReason}` as MessageKey)}</dd>
            </>
          )}

          {card.visit && (
            <>
              <dt>{t("calendar.visit")}</dt>
              <dd>
                <Link className="text-link" href="/app/visits">
                  {card.visit.completedAt.toLocaleDateString(tag)}
                </Link>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="panel">
        <h2>{t("calendar.whatWasBooked")}</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("calendar.service")}</th>
              <th>{t("calendar.duration")}</th>
              <th>{t("calendar.price")}</th>
            </tr>
          </thead>
          <tbody>
            {card.lines.map((line) => (
              <tr key={line.id}>
                <td>{resolveLocalizedText(line.nameSnapshot, locale, locale) ?? "—"}</td>
                <td>{line.durationMinutes}</td>
                <td>{formatMoneyMinor(line.priceMinor, currency, tag)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2}>{t("calendar.total")}</td>
              <td>{formatMoneyMinor(total, currency, tag)}</td>
            </tr>
          </tbody>
        </table>
        {/* The names and prices here are the booking's own copies. A price
            change tomorrow does not rewrite what this client was quoted. */}
        <p className="muted">{t("calendar.snapshotNote")}</p>
      </section>

      <section className="panel">
        <h2>{t("calendar.history")}</h2>
        {card.history.length === 0 ? (
          <p className="muted">{t("calendar.noHistory")}</p>
        ) : (
          <ul className="compact-list">
            {card.history.map((event) => (
              <li key={event.id}>
                {event.createdAt.toLocaleString(tag, { timeZone: timezone })} —{" "}
                {t(`bookingEvent.${event.eventType}` as MessageKey)}
                {event.actorEmail && <span className="unit-hint">{event.actorEmail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
